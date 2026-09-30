#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inspectPhpSource } = require("./php-analysis");
const { compareProfiles, exceedsRegressionGate } = require("./profile-compare");
const { inspectSchema, loadPlan, loadSchema } = require("./plan-review");

const TOOL = "Agent DevKit Laravel Performance Check";
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "vendor", "node_modules", "storage", "bootstrap/cache",
  "coverage", "build", "dist", ".next", ".idea", ".vscode",
]);
const MAX_SOURCE_BYTES = 768 * 1024;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  requestP95Ms: 1000,
  dbTimeP95Ms: 300,
  dbWaitP95Ms: 50,
  responseBytesP95: 256 * 1024,
  cpuP95Ms: 500,
  memoryBytesP95: 128 * 1024 * 1024,
  queryCallsPerRequestP95: 5,
  queueWaitP95Ms: 5000,
  queueDurationP95Ms: 30000,
  queueRetryRate: 0.05,
  cacheOperationWaitP95Ms: 25,
  cacheEvictionsPerMinuteP95: 1,
  workerMemoryBytesP95: 128 * 1024 * 1024,
  workerBusyRatioP95: 0.85,
  dbConnectionUtilizationP95: 0.8,
});
const OPTIONAL_LIMITS = new Set(["cacheHitRateMin"]);
const ALLOWED_LIMITS = new Set([...Object.keys(DEFAULT_LIMITS), ...OPTIONAL_LIMITS]);

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const options = {
    root: null, profile: null, baseline: null, plan: null, planEngine: "auto", schema: null,
    json: false, markdown: false, maxFiles: 5000, planRowReview: 10000, failOnRegression: undefined,
  };
  let index = 0;
  while (index < args.length) {
    const arg = args[index++];
    if (arg === "--json") options.json = true;
    else if (arg === "--markdown") options.markdown = true;
    else if (["--profile", "--baseline", "--plan", "--plan-engine", "--schema", "--max-files", "--plan-row-review", "--fail-on-regression"].includes(arg)) {
      if (!args[index] || args[index].startsWith("--")) throw new Error(`${arg} requires a value.`);
      const value = args[index++];
      if (arg === "--profile") options.profile = value;
      else if (arg === "--baseline") options.baseline = value;
      else if (arg === "--plan") options.plan = value;
      else if (arg === "--plan-engine") options.planEngine = value;
      else if (arg === "--schema") options.schema = value;
      else if (arg === "--fail-on-regression") {
        options.failOnRegression = Number(value);
        if (!Number.isFinite(options.failOnRegression) || options.failOnRegression < 0 || options.failOnRegression > 1000) {
          throw new Error("--fail-on-regression must be a percentage from 0 to 1000.");
        }
      }
      else {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${arg} must be a positive safe integer.`);
        if (arg === "--max-files") {
          options.maxFiles = number;
          if (options.maxFiles > 50000) throw new Error("--max-files cannot exceed 50000.");
        } else {
          options.planRowReview = number;
        }
      }
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (options.root === null) options.root = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.root) throw new Error("Provide a Laravel project directory.");
  if (options.json && options.markdown) throw new Error("Choose either --json or --markdown.");
  if (options.baseline && !options.profile) throw new Error("--baseline requires a current --profile.");
  if (options.failOnRegression !== undefined && !options.baseline) throw new Error("--fail-on-regression requires --baseline.");
  if (!["auto", "postgresql", "mysql"].includes(options.planEngine)) throw new Error("--plan-engine must be auto, postgresql, or mysql.");
  options.root = path.resolve(options.root);
  let rootStat;
  try {
    rootStat = fs.statSync(options.root);
  } catch {
    throw new Error(`Project directory does not exist: ${options.root}`);
  }
  if (!rootStat.isDirectory()) throw new Error(`Project path is not a directory: ${options.root}`);
  return options;
}

function helpText() {
  return `${TOOL}

Usage:
  node skills/laravel-pr-review/scripts/perf-scan.js <project-root> [options]

Options:
  --profile <file>   Read sanitized aggregate measurements (JSON, schema version 1)
  --baseline <file>  Compare the current --profile with a sanitized baseline profile
  --fail-on-regression <pct>  Exit 1 when a compared metric regresses by this percentage
  --plan <file>      Read offline PostgreSQL or MySQL EXPLAIN JSON (never executes SQL)
  --plan-engine <db> auto, postgresql, or mysql (default: auto)
  --plan-row-review <n>  Estimated rows for scan/sort review (default: 10000)
  --schema <file>    Read sanitized table/index/foreign-key metadata JSON
  --json             Print machine-readable findings
  --markdown         Print a Markdown report
  --max-files <n>    Maximum PHP files to inspect (default: 5000, max: 50000)
  -h, --help         Show this message

The source scan reads PHP files only. With --profile, it also reads that explicitly supplied JSON file.
It makes no network or database connections, executes no SQL, and writes no files.
Static results and explain/schema checks are review candidates, not proof of a production bottleneck.`;
}

function isSkippedDirectory(relativePath, name) {
  if (name.startsWith(".")) return true;
  if (SKIP_DIRS.has(name)) return true;
  const normalized = relativePath.split(path.sep).join("/");
  return SKIP_DIRS.has(normalized);
}

function collectPhpFiles(root, maxFiles) {
  const pending = [root];
  const files = [];
  let skippedLarge = 0;
  let truncated = false;

  while (pending.length && !truncated) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!isSkippedDirectory(relative, entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".php") continue;
      let size;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > MAX_SOURCE_BYTES) {
        skippedLarge++;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push(absolute);
    }
  }
  return { files: files.sort(), skippedLarge, truncated };
}

function inspectPhp(file, root) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return inspectPhpSource(content, root, file);
}

function assertObject(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field '${key}'. Provide aggregate metrics only; raw SQL and personal data are not accepted.`);
  }
}

function numeric(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label} must be a non-negative${integer ? " integer" : " number"}.`);
  }
}

function validateProfile(profile) {
  assertObject(profile, "Profile", new Set(["schemaVersion", "environment", "routes", "queues", "cache", "runtime", "thresholds"]));
  if (profile.schemaVersion !== 1) throw new Error("Profile schemaVersion must be 1.");
  if (!["staging", "production", "unknown"].includes(profile.environment)) {
    throw new Error("Profile environment must be staging, production, or unknown.");
  }
  if (!Array.isArray(profile.routes) || (profile.queues !== undefined && !Array.isArray(profile.queues))) {
    throw new Error("Profile routes and queues must be arrays.");
  }

  const routeKeys = new Set([
    "template", "sampleCount", "requestP95Ms", "dbTimeP95Ms", "dbWaitP95Ms",
    "responseBytesP95", "cpuP95Ms", "memoryBytesP95", "queryPatterns",
  ]);
  const queryKeys = new Set(["hash", "callsPerRequestP95", "timeP95Ms"]);
  for (const [index, route] of profile.routes.entries()) {
    assertObject(route, `routes[${index}]`, routeKeys);
    const routeParts = typeof route.template === "string" ? route.template.split(" ") : [];
    const routePath = routeParts[1] || "";
    const routeSegments = routePath.split("/").slice(1).filter(Boolean);
    const safeRouteSegments = routeSegments.every((segment) =>
      /^\{[A-Za-z_][A-Za-z0-9_]{0,30}\}$/.test(segment) || /^[A-Za-z][A-Za-z0-9._~-]{0,39}$/.test(segment));
    if (typeof route.template !== "string" || route.template.length > 160 ||
        !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE) \/[A-Za-z0-9_{}./-]*$/.test(route.template) ||
        !safeRouteSegments || /\d{5,}|@|%[0-9a-f]{2}/i.test(route.template)) {
      throw new Error(`routes[${index}].template must be a redacted HTTP route pattern without query strings or record IDs.`);
    }
    numeric(route.sampleCount, `routes[${index}].sampleCount`, true);
    if (route.sampleCount < 1) throw new Error(`routes[${index}].sampleCount must be greater than zero.`);
    for (const key of ["requestP95Ms", "dbTimeP95Ms", "dbWaitP95Ms", "responseBytesP95", "cpuP95Ms", "memoryBytesP95"]) {
      if (route[key] !== undefined) numeric(route[key], `routes[${index}].${key}`);
    }
    if (route.queryPatterns !== undefined && !Array.isArray(route.queryPatterns)) throw new Error(`routes[${index}].queryPatterns must be an array.`);
    for (const [queryIndex, query] of (route.queryPatterns || []).entries()) {
      assertObject(query, `routes[${index}].queryPatterns[${queryIndex}]`, queryKeys);
      if (typeof query.hash !== "string" || !/^[a-f0-9]{16,64}$/i.test(query.hash)) {
        throw new Error(`routes[${index}].queryPatterns[${queryIndex}].hash must be a hex fingerprint, not SQL text.`);
      }
      numeric(query.callsPerRequestP95, `routes[${index}].queryPatterns[${queryIndex}].callsPerRequestP95`);
      if (query.timeP95Ms !== undefined) numeric(query.timeP95Ms, `routes[${index}].queryPatterns[${queryIndex}].timeP95Ms`);
    }
  }

  const queueKeys = new Set(["name", "sampleCount", "waitP95Ms", "waitSampleCount", "durationP95Ms", "retryRate", "retrySampleCount"]);
  for (const [index, queue] of (profile.queues || []).entries()) {
    assertObject(queue, `queues[${index}]`, queueKeys);
    if (typeof queue.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(queue.name)) {
      throw new Error(`queues[${index}].name must be a short logical queue name.`);
    }
    numeric(queue.sampleCount, `queues[${index}].sampleCount`, true);
    if (queue.sampleCount < 1) throw new Error(`queues[${index}].sampleCount must be greater than zero.`);
    for (const key of ["waitP95Ms", "waitSampleCount", "durationP95Ms", "retryRate", "retrySampleCount"]) {
      if (queue[key] !== undefined) numeric(queue[key], `queues[${index}].${key}`);
    }
    for (const key of ["waitSampleCount", "retrySampleCount"]) {
      if (queue[key] !== undefined && (!Number.isSafeInteger(queue[key]) || queue[key] < 1)) {
        throw new Error(`queues[${index}].${key} must be a positive integer.`);
      }
    }
    for (const key of ["waitSampleCount", "retrySampleCount"]) {
      if (queue[key] !== undefined && queue[key] > queue.sampleCount) throw new Error(`queues[${index}].${key} cannot exceed sampleCount.`);
    }
    if (queue.retryRate !== undefined && queue.retryRate > 1) throw new Error(`queues[${index}].retryRate must be a ratio from 0 to 1.`);
  }

  let cache = null;
  if (profile.cache !== undefined) {
    const cacheKeys = new Set(["driver", "sampleCount", "hitRate", "hitSampleCount", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]);
    assertObject(profile.cache, "cache", cacheKeys);
    if (!["redis", "memcached", "database", "file", "array", "other"].includes(profile.cache.driver)) {
      throw new Error("cache.driver must name a supported cache backend.");
    }
    numeric(profile.cache.sampleCount, "cache.sampleCount", true);
    if (profile.cache.sampleCount < 1) throw new Error("cache.sampleCount must be greater than zero.");
    for (const key of ["hitRate", "hitSampleCount", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]) {
      if (profile.cache[key] !== undefined) numeric(profile.cache[key], `cache.${key}`);
    }
    if (profile.cache.hitSampleCount !== undefined && (!Number.isSafeInteger(profile.cache.hitSampleCount) || profile.cache.hitSampleCount < 1)) {
      throw new Error("cache.hitSampleCount must be a positive integer.");
    }
    if (profile.cache.hitSampleCount !== undefined && profile.cache.hitSampleCount > profile.cache.sampleCount) {
      throw new Error("cache.hitSampleCount cannot exceed cache.sampleCount.");
    }
    if (profile.cache.hitRate !== undefined && profile.cache.hitRate > 1) throw new Error("cache.hitRate must be a ratio from 0 to 1.");
    cache = profile.cache;
  }

  let runtime = null;
  if (profile.runtime !== undefined) {
    const runtimeKeys = new Set(["pool", "sampleCount", "workerMemoryBytesP95", "workerBusyRatioP95", "dbConnectionUtilizationP95"]);
    assertObject(profile.runtime, "runtime", runtimeKeys);
    if (!["php-fpm", "octane", "other"].includes(profile.runtime.pool)) {
      throw new Error("runtime.pool must be php-fpm, octane, or other.");
    }
    numeric(profile.runtime.sampleCount, "runtime.sampleCount", true);
    if (profile.runtime.sampleCount < 1) throw new Error("runtime.sampleCount must be greater than zero.");
    for (const key of ["workerMemoryBytesP95", "workerBusyRatioP95", "dbConnectionUtilizationP95"]) {
      if (profile.runtime[key] !== undefined) numeric(profile.runtime[key], `runtime.${key}`);
    }
    for (const key of ["workerBusyRatioP95", "dbConnectionUtilizationP95"]) {
      if (profile.runtime[key] !== undefined && profile.runtime[key] > 1) throw new Error(`runtime.${key} must be a ratio from 0 to 1.`);
    }
    runtime = profile.runtime;
  }

  const limits = { ...DEFAULT_LIMITS };
  const configuredLimits = {};
  if (profile.thresholds !== undefined) {
    assertObject(profile.thresholds, "thresholds", ALLOWED_LIMITS);
    for (const [key, value] of Object.entries(profile.thresholds)) {
      numeric(value, `thresholds.${key}`);
      if (OPTIONAL_LIMITS.has(key)) {
        if (value > 1) throw new Error(`thresholds.${key} must be a ratio from 0 to 1.`);
        configuredLimits[key] = value;
        continue;
      }
      if (value === 0) throw new Error(`thresholds.${key} must be greater than zero.`);
      limits[key] = value;
      configuredLimits[key] = value;
    }
  }
  return { environment: profile.environment, routes: profile.routes, queues: profile.queues || [], cache, runtime, limits, configuredLimits };
}

function readProfile(file) {
  let parsed;
  try {
    if (fs.statSync(file).size > MAX_PROFILE_BYTES) throw new Error("profile file exceeds the 2 MiB safety limit");
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read profile JSON: ${error.message}`);
  }
  return validateProfile(parsed);
}

function addMeasuredFinding(findings, rule, label, metric, value, limit, samples, recommendation, statistic = "p95") {
  if (value === undefined || value <= limit) return;
  findings.push({
    rule,
    severity: value >= limit * 2 ? "high" : "medium",
    confidence: "measured-input",
    source: "profile",
    location: label,
    evidence: `${metric} ${statistic} is ${value}; review threshold is ${limit} (${samples} samples).`,
    recommendation,
  });
}

function addBelowLimitFinding(findings, rule, label, metric, value, minimum, samples, recommendation) {
  if (value === undefined || value >= minimum) return;
  findings.push({
    rule,
    severity: value <= minimum / 2 ? "high" : "medium",
    confidence: "measured-input",
    source: "profile",
    location: label,
    evidence: `${metric} is ${value}; configured minimum is ${minimum} (${samples} samples).`,
    recommendation,
  });
}

function inspectProfile(profile, findings) {
  if (!profile) return null;
  const limits = profile.limits;
  for (const route of profile.routes) {
    addMeasuredFinding(findings, "ROUTE_LATENCY_P95", route.template, "Request latency ms", route.requestP95Ms,
      limits.requestP95Ms, route.sampleCount, "Break the request into application, database, and external spans before choosing an optimization.");
    addMeasuredFinding(findings, "DATABASE_TIME_P95", route.template, "Database time ms", route.dbTimeP95Ms,
      limits.dbTimeP95Ms, route.sampleCount, "Inspect normalized query fingerprints and a sanitized plan from a representative non-production environment.");
    addMeasuredFinding(findings, "DATABASE_WAIT_P95", route.template, "Database connection wait ms", route.dbWaitP95Ms,
      limits.dbWaitP95Ms, route.sampleCount, "Compare worker concurrency, transaction length, pool behavior, and the database connection budget.");
    addMeasuredFinding(findings, "RESPONSE_BYTES_P95", route.template, "Response bytes", route.responseBytesP95,
      limits.responseBytesP95, route.sampleCount, "Review the response shape, required fields, and pagination while preserving authorization and API compatibility.");
    addMeasuredFinding(findings, "CPU_TIME_P95", route.template, "CPU time ms", route.cpuP95Ms,
      limits.cpuP95Ms, route.sampleCount, "Profile the hot path before changing algorithms, worker counts, or runtime settings.");
    addMeasuredFinding(findings, "MEMORY_P95", route.template, "Peak memory bytes", route.memoryBytesP95,
      limits.memoryBytesP95, route.sampleCount, "Inspect collection materialization and worker lifetime; verify memory limits against measured host capacity.");
    for (const query of route.queryPatterns || []) {
      addMeasuredFinding(findings, "REPEATED_QUERY_PATTERN", route.template, `Calls for query fingerprint ${query.hash.slice(0, 12)}`,
        query.callsPerRequestP95, limits.queryCallsPerRequestP95, route.sampleCount,
        "Check whether this pattern repeats for each item in a collection. Batch or eager-load only after confirming result semantics.");
      addMeasuredFinding(findings, "QUERY_PATTERN_TIME_P95", route.template, `Query fingerprint ${query.hash.slice(0, 12)} time ms`,
        query.timeP95Ms, limits.dbTimeP95Ms, route.sampleCount,
        "Correlate this fingerprint with a sanitized query plan and index metadata; the scanner cannot determine index coverage by itself.");
    }
  }
  for (const queue of profile.queues) {
      addMeasuredFinding(findings, "QUEUE_WAIT_P95", `queue:${queue.name}`, "Queue wait ms", queue.waitP95Ms,
      limits.queueWaitP95Ms, queue.waitSampleCount || queue.sampleCount, "Compare arrival rate, worker availability, queue priority, and downstream capacity.");
    addMeasuredFinding(findings, "QUEUE_DURATION_P95", `queue:${queue.name}`, "Job duration ms", queue.durationP95Ms,
      limits.queueDurationP95Ms, queue.sampleCount, "Profile the job, bound batch size, and preserve idempotency and retry behavior.");
    addMeasuredFinding(findings, "QUEUE_RETRY_RATE", `queue:${queue.name}`, "Job retry ratio", queue.retryRate,
      limits.queueRetryRate, queue.retrySampleCount || queue.sampleCount, "Inspect failure causes and retry policy; do not raise concurrency until downstream capacity is understood.", "aggregate ratio");
  }
  if (profile.cache) {
    const cache = profile.cache;
    const label = `cache:${cache.driver}`;
    if (profile.configuredLimits.cacheHitRateMin !== undefined) {
      addBelowLimitFinding(findings, "CACHE_HIT_RATE", label, "Cache hit ratio", cache.hitRate,
        profile.configuredLimits.cacheHitRateMin, cache.hitSampleCount || cache.sampleCount,
        "Verify that the measured key population is expected to be cacheable, then inspect key scope, TTL, and invalidation before changing cache policy.");
    }
    addMeasuredFinding(findings, "CACHE_OPERATION_WAIT_P95", label, "Cache operation wait ms", cache.operationWaitP95Ms,
      limits.cacheOperationWaitP95Ms, cache.sampleCount, "Check backend latency, network placement, payload size, and whether cache calls serialize the request path.");
    addMeasuredFinding(findings, "CACHE_EVICTIONS_P95", label, "Cache evictions per minute", cache.evictionsPerMinuteP95,
      limits.cacheEvictionsPerMinuteP95, cache.sampleCount, "Review memory pressure, key growth, TTL policy, and eviction settings before expanding cache usage.");
  }
  if (profile.runtime) {
    const runtime = profile.runtime;
    const label = `runtime:${runtime.pool}`;
    addMeasuredFinding(findings, "WORKER_MEMORY_P95", label, "Worker memory bytes", runtime.workerMemoryBytesP95,
      limits.workerMemoryBytesP95, runtime.sampleCount,
      runtime.pool === "octane"
        ? "Check for request-specific state retained by long-lived workers and measure restart behavior before adjusting worker recycling."
        : "Compare measured per-worker memory with host capacity before tuning the PHP-FPM process pool.");
    addMeasuredFinding(findings, "WORKER_BUSY_RATIO_P95", label, "Worker busy ratio", runtime.workerBusyRatioP95,
      limits.workerBusyRatioP95, runtime.sampleCount, "Compare queueing and request time with measured worker capacity; avoid increasing concurrency without checking memory and downstream limits.");
    addMeasuredFinding(findings, "DB_CONNECTION_UTILIZATION_P95", label, "Database connection utilization ratio", runtime.dbConnectionUtilizationP95,
      limits.dbConnectionUtilizationP95, runtime.sampleCount, "Compare active application workers and database connections with the database's configured connection budget.");
  }
  return {
    environment: profile.environment,
    routeCount: profile.routes.length,
    queueCount: profile.queues.length,
    cacheProfileIncluded: Boolean(profile.cache),
    runtimeProfileIncluded: Boolean(profile.runtime),
  };
}

function analyze(options) {
  const { files, skippedLarge, truncated } = collectPhpFiles(options.root, options.maxFiles);
  const findings = [];
  for (const file of files) findings.push(...inspectPhp(file, options.root));

  const profile = options.profile ? readProfile(path.resolve(options.profile)) : null;
  const profileSummary = inspectProfile(profile, findings);
  const baseline = options.baseline ? readProfile(path.resolve(options.baseline)) : null;
  const comparison = baseline ? compareProfiles(baseline, profile) : null;
  const plan = options.plan ? loadPlan(path.resolve(options.plan), options.planEngine, options.planRowReview) : null;
  const schema = options.schema ? loadSchema(path.resolve(options.schema)) : null;
  if (plan && schema && plan.engine !== schema.engine) throw new Error("EXPLAIN plan and schema metadata engines must match.");
  if (plan) findings.push(...plan.findings);
  const schemaSummary = schema ? inspectSchema(schema) : null;
  if (schemaSummary) findings.push(...schemaSummary.findings);
  const order = { high: 0, medium: 1, review: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity] ||
    left.location.localeCompare(right.location) || left.rule.localeCompare(right.rule));

  return {
    tool: TOOL,
    scannedPhpFiles: files.length,
    skippedOversizeFiles: skippedLarge,
    fileLimitReached: truncated,
    profile: profileSummary,
    comparison,
    plan: plan ? { engine: plan.engine, nodeCount: plan.nodeCount, rowReviewThreshold: plan.rowReviewThreshold, nodes: plan.nodes } : null,
    schema: schemaSummary ? { engine: schema.engine, ...schemaSummary } : null,
    profileMeasurements: profile ? {
      routes: profile.routes,
      queues: profile.queues,
      cache: profile.cache,
      runtime: profile.runtime,
    } : null,
    thresholds: profile ? { ...profile.limits, ...profile.configuredLimits } : null,
    findingCount: findings.length,
    findings,
    regressionGateExceeded: comparison ? exceedsRegressionGate(comparison, options.failOnRegression) : false,
    limitations: [
      "PHP checks are lexical structural candidates, not a complete PHP AST or proof of runtime behavior.",
      "EXPLAIN checks use planner estimates; schema metadata omits engine-specific index semantics and must be verified against a real catalog.",
      "Profiles come from user-supplied aggregates or offline OTLP spans; this tool does not collect or independently verify telemetry.",
    ],
  };
}

function printReport(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.tool}\n`);
  process.stdout.write(`PHP files scanned: ${result.scannedPhpFiles}; large files skipped: ${result.skippedOversizeFiles}`);
  if (result.fileLimitReached) process.stdout.write("; file limit reached");
  process.stdout.write("\n");
  if (result.profile) {
    process.stdout.write(`Aggregate profile: ${result.profile.environment}; routes=${result.profile.routeCount}; queues=${result.profile.queueCount}\n`);
    for (const route of result.profileMeasurements.routes) {
      const values = ["requestP95Ms", "dbTimeP95Ms", "dbWaitP95Ms", "responseBytesP95", "cpuP95Ms", "memoryBytesP95"]
        .filter((key) => route[key] !== undefined).map((key) => `${key}=${route[key]}`);
      process.stdout.write(`  ${route.template} (${route.sampleCount} samples): ${values.join(", ")}\n`);
    }
    for (const queue of result.profileMeasurements.queues) {
      const values = ["waitP95Ms", "waitSampleCount", "durationP95Ms", "retryRate", "retrySampleCount"]
        .filter((key) => queue[key] !== undefined).map((key) => `${key}=${queue[key]}`);
      process.stdout.write(`  queue:${queue.name} (${queue.sampleCount} samples): ${values.join(", ")}\n`);
    }
    if (result.profileMeasurements.cache) {
      const cache = result.profileMeasurements.cache;
      const values = ["hitRate", "hitSampleCount", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]
        .filter((key) => cache[key] !== undefined).map((key) => `${key}=${cache[key]}`);
      process.stdout.write(`  cache:${cache.driver} (${cache.sampleCount} samples): ${values.join(", ")}\n`);
    }
    if (result.profileMeasurements.runtime) {
      const runtime = result.profileMeasurements.runtime;
      const values = ["workerMemoryBytesP95", "workerBusyRatioP95", "dbConnectionUtilizationP95"]
        .filter((key) => runtime[key] !== undefined).map((key) => `${key}=${runtime[key]}`);
      process.stdout.write(`  runtime:${runtime.pool} (${runtime.sampleCount} samples): ${values.join(", ")}\n`);
    }
  }
  if (result.comparison) {
    process.stdout.write(`Baseline comparison (${result.comparison.baselineEnvironment} → ${result.comparison.currentEnvironment}): ${result.comparison.regressionCount}/${result.comparison.comparedMetricCount} regressions\n`);
    for (const metric of result.comparison.metrics) {
      const change = metric.changePercent === null
        ? `new from zero (${metric.regression ? "regression" : "improvement"})` : `${metric.changePercent}%`;
      process.stdout.write(`  ${metric.regression ? "REGRESSION" : "OK"} ${metric.scope} ${metric.metric}: ${metric.baseline} -> ${metric.current} (${change})\n`);
    }
    if (result.regressionGateExceeded && result.comparison.comparedMetricCount === 0) {
      process.stdout.write("  No metrics matched; the regression gate fails closed.\n");
    }
  }
  if (!result.findings.length) process.stdout.write("No candidate patterns crossed the configured thresholds. This is not proof of good performance.\n");
  for (const finding of result.findings) {
    process.stdout.write(`\n[${finding.severity.toUpperCase()}] ${finding.rule} — ${finding.location}\n`);
    process.stdout.write(`  Evidence: ${finding.evidence}\n  Next step: ${finding.recommendation}\n`);
  }
  for (const limitation of result.limitations) process.stdout.write(`\nNote: ${limitation}\n`);
}

function markdownCell(value) {
  return String(value ?? "—").replace(/[|\r\n]/g, " ").replace(/[`*_{}\[\]<>#\\]/g, "\\$&");
}

function printMarkdown(result) {
  process.stdout.write(`# ${result.tool}\n\n`);
  process.stdout.write(`PHP files scanned: ${result.scannedPhpFiles}; skipped large: ${result.skippedOversizeFiles}${result.fileLimitReached ? "; file limit reached" : ""}.\n\n`);
  if (result.profile) process.stdout.write(`Profile: ${result.profile.environment}; routes ${result.profile.routeCount}; queues ${result.profile.queueCount}.\n\n`);
  if (result.comparison) {
    process.stdout.write(`## Baseline comparison\n\nEnvironment: ${result.comparison.baselineEnvironment} → ${result.comparison.currentEnvironment}. Regressions: ${result.comparison.regressionCount}/${result.comparison.comparedMetricCount}.\n\n`);
    process.stdout.write("| Scope | Metric | Baseline | Current | Change | Result |\n|---|---|---:|---:|---:|---|\n");
    for (const metric of result.comparison.metrics) {
      const change = metric.changePercent === null
        ? `new from zero (${metric.regression ? "regression" : "improvement"})` : `${metric.changePercent}%`;
      process.stdout.write(`| ${markdownCell(metric.scope)} | ${markdownCell(metric.metric)} | ${metric.baseline} | ${metric.current} | ${change} | ${metric.regression ? "Regression" : "No regression"} |\n`);
    }
    if (result.comparison.newRoutes.length || result.comparison.removedRoutes.length) {
      process.stdout.write(`\nNew routes: ${result.comparison.newRoutes.map(markdownCell).join(", ") || "none"}; removed routes: ${result.comparison.removedRoutes.map(markdownCell).join(", ") || "none"}.\n`);
    }
    if (result.regressionGateExceeded && result.comparison.comparedMetricCount === 0) {
      process.stdout.write("\nNo comparable metrics were found; the regression gate fails closed.\n");
    }
    process.stdout.write("\n");
  }
  if (result.plan) process.stdout.write(`EXPLAIN: ${result.plan.engine}; ${result.plan.nodeCount} sanitized plan nodes; row review threshold ${result.plan.rowReviewThreshold}.\n\n`);
  if (result.schema) process.stdout.write(`Schema metadata: ${result.schema.engine}; ${result.schema.tableCount} tables; ${result.schema.indexCount} indexes.\n\n`);
  process.stdout.write("## Findings\n\n");
  if (!result.findings.length) process.stdout.write("No candidate findings. This is not proof of good performance.\n\n");
  for (const finding of result.findings) {
    process.stdout.write(`### ${markdownCell(finding.rule)} — ${markdownCell(finding.location)}\n\n`);
    process.stdout.write(`- Severity: ${markdownCell(finding.severity)}\n- Evidence: ${markdownCell(finding.evidence)}\n- Recommendation: ${markdownCell(finding.recommendation)}\n\n`);
  }
  process.stdout.write("## Limitations\n\n");
  for (const limitation of result.limitations) process.stdout.write(`- ${markdownCell(limitation)}\n`);
  if (result.regressionGateExceeded) process.stdout.write("\n**Regression gate failed.**\n");
}

try {
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    process.stdout.write(`${helpText()}\n`);
  } else {
    const options = parseArgs(process.argv.slice(2));
    const result = analyze(options);
    if (options.markdown) printMarkdown(result);
    else printReport(result, options.json);
    if (result.regressionGateExceeded) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 2;
}
