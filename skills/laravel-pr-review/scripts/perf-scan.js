#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
  const options = { root: null, profile: null, json: false, maxFiles: 5000 };
  let index = 0;
  while (index < args.length) {
    const arg = args[index++];
    if (arg === "--json") options.json = true;
    else if (arg === "--profile" || arg === "--max-files") {
      if (!args[index] || args[index].startsWith("--")) throw new Error(`${arg} requires a value.`);
      const value = args[index++];
      if (arg === "--profile") options.profile = value;
      else {
        options.maxFiles = Number(value);
        if (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 50000) {
          throw new Error("--max-files must be an integer from 1 to 50000.");
        }
      }
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (options.root === null) options.root = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!options.root) throw new Error("Provide a Laravel project directory.");
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
  --json             Print machine-readable findings
  --max-files <n>    Maximum PHP files to inspect (default: 5000, max: 50000)
  -h, --help         Show this message

The source scan reads PHP files only. With --profile, it also reads that explicitly supplied JSON file.
It makes no network or database connections and writes no files.
Static results are review candidates, not proof of a production bottleneck.`;
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

function removeComments(lines) {
  let inBlock = false;
  return lines.map((line) => {
    let result = "";
    let index = 0;
    let quote = null;
    let escaped = false;
    while (index < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", index);
        if (end < 0) return result;
        index = end + 2;
        inBlock = false;
      } else if (quote) {
        const char = line[index++];
        result += char;
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
      } else if (line[index] === "'" || line[index] === '"' || line[index] === "`") {
        quote = line[index];
        result += line[index++];
      } else if (line.startsWith("/*", index)) {
        inBlock = true;
        index += 2;
      } else if (line.startsWith("//", index) || (line[index] === "#" && !line.startsWith("#[", index))) {
        break;
      } else {
        result += line[index++];
      }
    }
    return result;
  });
}

function safePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/").replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 240);
}

function addStaticFinding(findings, root, file, line, rule, confidence, evidence, recommendation) {
  findings.push({
    rule,
    severity: "review",
    confidence,
    source: "static",
    location: `${safePath(root, file)}:${line + 1}`,
    evidence,
    recommendation,
  });
}

function braceDelta(line) {
  let delta = 0;
  let quote = null;
  let escaped = false;
  for (const char of line) {
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") delta++;
    else if (char === "}") delta--;
  }
  return delta;
}

function loopRange(lines, start) {
  let depth = 0;
  let opened = false;
  const limit = Math.min(lines.length - 1, start + 120);
  for (let line = start; line <= limit; line++) {
    const delta = braceDelta(lines[line]);
    if (delta > 0) opened = true;
    depth += delta;
    if (opened && depth <= 0) return [start, line];
    if (!opened && line > start) return [start, start];
  }
  return [start, limit];
}

function expressionContext(lines, line) {
  let start = Math.max(0, line - 12);
  for (let cursor = line - 1; cursor >= start; cursor--) {
    if (lines[cursor].includes(";") || lines[cursor].includes("}")) {
      start = cursor + 1;
      break;
    }
  }
  return lines.slice(start, line + 1).join(" ");
}

function inspectPhp(file, root, findings) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const lines = removeComments(content.split(/\r?\n/));

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/\bforeach\s*\(/.test(line)) {
      const [start, end] = loopRange(lines, index);
      const body = lines.slice(start, end + 1).join(" ");
      if (/\b(?:DB\s*::|\w+\s*::\s*(?:query|where|find|all)\b|->\s*(?:get|first|find|count|exists|value|sum|avg)\s*\()/i.test(body)) {
        addStaticFinding(
          findings, root, file, index, "DATABASE_CALL_IN_LOOP", "medium",
          "A database-shaped call appears in a foreach body; confirm it runs once per item.",
          "Move data access to a batch query or preload the required records, then compare query traces on an isolated dataset."
        );
      }
      const scalarFields = new Set([
        "id", "uuid", "name", "email", "title", "status", "slug", "created_at", "updated_at",
        "deleted_at", "tenant_id", "type", "amount", "total", "currency", "active", "enabled",
      ]);
      const possibleRelationRead = [...body.matchAll(/\$[A-Za-z_]\w*\s*->\s*([A-Za-z_]\w*)\b(?!\s*\()/gi)]
        .some((match) => !scalarFields.has(match[1].toLowerCase()));
      if (possibleRelationRead) {
        addStaticFinding(
          findings, root, file, index, "RELATION_ACCESS_IN_LOOP", "low",
          "An object property is read in a foreach body; it may be an Eloquent relation that lazy-loads.",
          "Check the model relation and serializer path. If it issues a query per item, eager-load only the needed relation and validate query counts in tests."
        );
      }
    }

    if (/->\s*get\s*\(/i.test(line)) {
      const context = expressionContext(lines, index);
      if (!/->\s*(?:limit|take|paginate|simplePaginate|cursorPaginate|chunk|chunkById|cursor|lazy)\s*\(/i.test(context)) {
        addStaticFinding(
          findings, root, file, index, "COLLECTION_GET_WITHOUT_VISIBLE_BOUND", "low",
          "A query-shaped get() has no page, limit, or streaming method in its nearby expression.",
          "Verify the maximum result size. Select only required columns and add bounded pagination or chunked processing where the response contract permits."
        );
      }
    }

    if (/\bselect\s+\*\s+from\b/i.test(line)) {
      addStaticFinding(
        findings, root, file, index, "RAW_SELECT_STAR", "medium",
        "A raw SQL string appears to request every column.",
        "List the columns needed by this path and confirm that omitting fields preserves model, authorization, and serialization behavior."
      );
    }

    if (/(?:->|::)\s*(?:simplePaginate|paginate)\s*\(\s*(?:request\s*\(|\$request\s*->\s*(?:input|query)\s*\()/i.test(line)) {
      addStaticFinding(
        findings, root, file, index, "UNBOUNDED_PAGE_SIZE_INPUT", "medium",
        "Pagination size appears to come directly from request input.",
        "Clamp the requested page size to a documented server-side maximum and test invalid, negative, and unusually large values."
      );
    }

    if (/->\s*count\s*\(\s*\)\s*(?:>|!==?\s*0|!=\s*0)/i.test(line)) {
      addStaticFinding(
        findings, root, file, index, "COUNT_USED_AS_BOOLEAN", "low",
        "A count result appears to be used only as an existence check.",
        "If only presence matters, compare the semantics and consider an existence query rather than counting every match."
      );
    }
  }
}

function assertObject(value, label, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`${label} contains unsupported field '${key}'. Provide aggregate metrics only; raw SQL and personal data are not accepted.`);
  }
}

function numeric(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
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
    if (typeof route.template !== "string" || route.template.length > 160 ||
        !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \/[A-Za-z0-9_{}:./-]*$/.test(route.template) || /\d{5,}/.test(route.template)) {
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

  const queueKeys = new Set(["name", "sampleCount", "waitP95Ms", "durationP95Ms", "retryRate"]);
  for (const [index, queue] of (profile.queues || []).entries()) {
    assertObject(queue, `queues[${index}]`, queueKeys);
    if (typeof queue.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(queue.name)) {
      throw new Error(`queues[${index}].name must be a short logical queue name.`);
    }
    numeric(queue.sampleCount, `queues[${index}].sampleCount`, true);
    if (queue.sampleCount < 1) throw new Error(`queues[${index}].sampleCount must be greater than zero.`);
    for (const key of ["waitP95Ms", "durationP95Ms", "retryRate"]) {
      if (queue[key] !== undefined) numeric(queue[key], `queues[${index}].${key}`);
    }
    if (queue.retryRate !== undefined && queue.retryRate > 1) throw new Error(`queues[${index}].retryRate must be a ratio from 0 to 1.`);
  }

  let cache = null;
  if (profile.cache !== undefined) {
    const cacheKeys = new Set(["driver", "sampleCount", "hitRate", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]);
    assertObject(profile.cache, "cache", cacheKeys);
    if (!["redis", "memcached", "database", "file", "array", "other"].includes(profile.cache.driver)) {
      throw new Error("cache.driver must name a supported cache backend.");
    }
    numeric(profile.cache.sampleCount, "cache.sampleCount", true);
    if (profile.cache.sampleCount < 1) throw new Error("cache.sampleCount must be greater than zero.");
    for (const key of ["hitRate", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]) {
      if (profile.cache[key] !== undefined) numeric(profile.cache[key], `cache.${key}`);
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
      limits.queueWaitP95Ms, queue.sampleCount, "Compare arrival rate, worker availability, queue priority, and downstream capacity.");
    addMeasuredFinding(findings, "QUEUE_DURATION_P95", `queue:${queue.name}`, "Job duration ms", queue.durationP95Ms,
      limits.queueDurationP95Ms, queue.sampleCount, "Profile the job, bound batch size, and preserve idempotency and retry behavior.");
    addMeasuredFinding(findings, "QUEUE_RETRY_RATE", `queue:${queue.name}`, "Job retry ratio", queue.retryRate,
      limits.queueRetryRate, queue.sampleCount, "Inspect failure causes and retry policy; do not raise concurrency until downstream capacity is understood.", "aggregate ratio");
  }
  if (profile.cache) {
    const cache = profile.cache;
    const label = `cache:${cache.driver}`;
    if (profile.configuredLimits.cacheHitRateMin !== undefined) {
      addBelowLimitFinding(findings, "CACHE_HIT_RATE", label, "Cache hit ratio", cache.hitRate,
        profile.configuredLimits.cacheHitRateMin, cache.sampleCount,
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
  for (const file of files) inspectPhp(file, options.root, findings);

  const profile = options.profile ? readProfile(path.resolve(options.profile)) : null;
  const profileSummary = inspectProfile(profile, findings);
  const order = { high: 0, medium: 1, review: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity] ||
    left.location.localeCompare(right.location) || left.rule.localeCompare(right.rule));

  return {
    tool: TOOL,
    scannedPhpFiles: files.length,
    skippedOversizeFiles: skippedLarge,
    fileLimitReached: truncated,
    profile: profileSummary,
    profileMeasurements: profile ? {
      routes: profile.routes,
      queues: profile.queues,
      cache: profile.cache,
      runtime: profile.runtime,
    } : null,
    thresholds: profile ? { ...profile.limits, ...profile.configuredLimits } : null,
    findingCount: findings.length,
    findings,
    limitations: [
      "Static patterns are candidates and may be false positives; inspect surrounding code.",
      "Missing indexes, real latency, memory, CPU, and connection behavior cannot be proven from source alone.",
      "Profile metrics are user-supplied aggregates, not measurements performed by this tool.",
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
      const values = ["waitP95Ms", "durationP95Ms", "retryRate"]
        .filter((key) => queue[key] !== undefined).map((key) => `${key}=${queue[key]}`);
      process.stdout.write(`  queue:${queue.name} (${queue.sampleCount} samples): ${values.join(", ")}\n`);
    }
    if (result.profileMeasurements.cache) {
      const cache = result.profileMeasurements.cache;
      const values = ["hitRate", "operationWaitP95Ms", "evictionsPerMinuteP95", "memoryBytesP95"]
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
  if (!result.findings.length) process.stdout.write("No candidate patterns crossed the configured thresholds. This is not proof of good performance.\n");
  for (const finding of result.findings) {
    process.stdout.write(`\n[${finding.severity.toUpperCase()}] ${finding.rule} — ${finding.location}\n`);
    process.stdout.write(`  Evidence: ${finding.evidence}\n  Next step: ${finding.recommendation}\n`);
  }
  for (const limitation of result.limitations) process.stdout.write(`\nNote: ${limitation}\n`);
}

try {
  if (process.argv.slice(2).includes("--help") || process.argv.slice(2).includes("-h")) {
    process.stdout.write(`${helpText()}\n`);
  } else {
    const options = parseArgs(process.argv.slice(2));
    printReport(analyze(options), options.json);
  }
} catch (error) {
  process.stderr.write(`Error: ${error.message}\n`);
  process.exitCode = 2;
}
