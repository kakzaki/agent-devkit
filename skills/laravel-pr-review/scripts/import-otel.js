#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_SPANS = 200000;
const SAFE_OPERATION = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$.-]{0,63}$/;

function parseArgs(args) {
  const options = { input: null, output: null, environment: "unknown", force: false };
  let index = 0;
  while (index < args.length) {
    const argument = args[index++];
    if (argument === "--environment" || argument === "--output") {
      if (!args[index] || args[index].startsWith("--")) throw new Error(`${argument} requires a value.`);
      const value = args[index++];
      if (argument === "--environment") options.environment = value;
      else options.output = path.resolve(value);
    } else if (argument === "--force") options.force = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (options.input === null) options.input = path.resolve(argument);
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.input) throw new Error("Provide an OTLP JSON trace export file.");
  if (!options.output) throw new Error("Provide --output <profile.json> so the generated aggregate is saved intentionally.");
  if (!new Set(["staging", "production", "unknown"]).has(options.environment)) {
    throw new Error("--environment must be staging, production, or unknown.");
  }
  if (options.force && !options.output) throw new Error("--force requires --output.");
  if (options.input === options.output) throw new Error("Input and output paths must be different.");
  return options;
}

function helpText() {
  return `Import OTLP JSON traces into an Agent DevKit aggregate profile.

Usage:
  node import-otel.js <traces.json> --output <profile.json> [options]

Options:
  --environment <name>  staging, production, or unknown (default: unknown)
  --output <file>       Write sanitized aggregates; refuses to overwrite by default
  --force               Replace the explicitly named output file
  -h, --help            Show this message

This is an offline file importer. It makes no network or database connections.
SQL text, span names, IDs, arbitrary attributes, and request data are never copied to output.`;
}

function primitive(attribute) {
  if (!attribute || typeof attribute !== "object") return undefined;
  const value = attribute.value;
  if (!value || typeof value !== "object") return undefined;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  return undefined;
}

function attributesFrom(list) {
  const result = new Map();
  if (!Array.isArray(list)) return result;
  for (const item of list) {
    if (item && typeof item.key === "string" && !result.has(item.key)) result.set(item.key, primitive(item));
  }
  return result;
}

function attribute(attrs, ...keys) {
  for (const key of keys) {
    if (attrs.has(key)) return attrs.get(key);
  }
  return undefined;
}

function safeRoute(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 || !value.startsWith("/") || /[?#\\\s\u0000-\u001f]/.test(value)) return null;
  const segments = value.split("/").slice(1);
  const normalized = [];
  for (const segment of segments) {
    if (!segment) continue;
    if (/^\{[A-Za-z_][A-Za-z0-9_]{0,30}\}$/.test(segment)) {
      normalized.push(segment);
    } else if (/^(?:\d{1,18}|[a-f0-9]{8}-[a-f0-9-]{27,}|[a-f0-9]{24,})$/i.test(segment)) {
      normalized.push("{id}");
    } else if (/^[A-Za-z][A-Za-z0-9._~-]{0,39}$/.test(segment)) {
      normalized.push(segment);
    } else {
      return null;
    }
  }
  return `/${normalized.join("/")}`.slice(0, 160);
}

function safeName(value, pattern = SAFE_IDENTIFIER) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function numericAttribute(attrs, ...keys) {
  const value = attribute(attrs, ...keys);
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
  return undefined;
}

function spanTime(span) {
  if (!/^\d+$/.test(String(span.startTimeUnixNano || "")) || !/^\d+$/.test(String(span.endTimeUnixNano || ""))) return null;
  const start = BigInt(span.startTimeUnixNano);
  const end = BigInt(span.endTimeUnixNano);
  if (end < start) return null;
  const duration = Number(end - start) / 1e6;
  return Number.isFinite(duration) ? { startMs: Number(start) / 1e6, durationMs: duration } : null;
}

function percentile(values, ratio = 0.95) {
  if (!values.length) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)].toFixed(3));
}

function flattenOtlp(root) {
  if (!root || typeof root !== "object" || !Array.isArray(root.resourceSpans)) throw new Error("Input must be an OTLP JSON traces export with resourceSpans[].");
  const result = [];
  for (const resource of root.resourceSpans) {
    const resourceAttrs = attributesFrom(resource?.resource?.attributes);
    for (const scope of resource?.scopeSpans || resource?.instrumentationLibrarySpans || []) {
      for (const raw of scope?.spans || []) {
        if (result.length >= MAX_SPANS) throw new Error(`Input contains more than ${MAX_SPANS} spans.`);
        if (!raw || typeof raw !== "object" || !/^[a-f0-9]{32}$/i.test(raw.traceId || "") || !/^[a-f0-9]{16}$/i.test(raw.spanId || "")) continue;
        const timing = spanTime(raw);
        if (!timing) continue;
        const spanAttrs = attributesFrom(raw.attributes);
        const attrs = new Map(resourceAttrs);
        for (const [key, value] of spanAttrs) attrs.set(key, value);
        result.push({
          traceId: raw.traceId.toLowerCase(),
          spanId: raw.spanId.toLowerCase(),
          parentSpanId: typeof raw.parentSpanId === "string" ? raw.parentSpanId.toLowerCase() : "",
          kind: raw.kind,
          attrs,
          timing,
        });
      }
    }
  }
  return result;
}

function isServerSpan(span) {
  return span.kind === 2 || span.kind === "SPAN_KIND_SERVER" ||
    attribute(span.attrs, "http.route", "url.template") !== undefined;
}

function requestRoute(span) {
  const methodRaw = attribute(span.attrs, "http.request.method", "http.method");
  const method = typeof methodRaw === "string" && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE)$/i.test(methodRaw) ? methodRaw.toUpperCase() : null;
  const route = safeRoute(attribute(span.attrs, "http.route", "url.template"));
  return method && route ? `${method} ${route}` : null;
}

function isDescendant(candidate, ancestor, byId) {
  let parent = candidate.parentSpanId;
  const visited = new Set();
  while (parent && !visited.has(parent)) {
    if (parent === ancestor.spanId) return true;
    visited.add(parent);
    parent = byId.get(parent)?.parentSpanId || "";
  }
  return false;
}

function dbFingerprint(span) {
  const system = safeName(attribute(span.attrs, "db.system.name", "db.system"), /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/);
  const operation = safeName(attribute(span.attrs, "db.operation.name", "db.operation"), SAFE_OPERATION);
  if (!system || !operation) return null;
  const namespace = safeName(attribute(span.attrs, "db.namespace", "db.name")) || "";
  const collection = safeName(attribute(span.attrs, "db.collection.name")) || "";
  const hash = crypto.createHash("sha256").update([system.toLowerCase(), operation.toUpperCase(), namespace.toLowerCase(), collection.toLowerCase()].join("|"))
    .digest("hex").slice(0, 16);
  return { hash, system: system.toLowerCase(), operation: operation.toUpperCase() };
}

function timestampMs(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function aggregateOtlp(root, environment = "unknown") {
  if (!new Set(["staging", "production", "unknown"]).has(environment)) throw new Error("Environment must be staging, production, or unknown.");
  const spans = flattenOtlp(root);
  if (spans.length === 0) throw new Error("No valid spans found; valid trace/span IDs and nanosecond timestamps are required.");
  const traces = new Map();
  for (const span of spans) {
    if (!traces.has(span.traceId)) traces.set(span.traceId, []);
    traces.get(span.traceId).push(span);
  }

  const routeSamples = new Map();
  const queueSamples = new Map();
  const cacheDurations = [];
  const cacheHits = [];
  const cacheDrivers = new Set();

  for (const traceSpans of traces.values()) {
    const byId = new Map(traceSpans.map((span) => [span.spanId, span]));
    const requests = traceSpans.filter((span) => isServerSpan(span) && requestRoute(span));
    for (const request of requests) {
      if (requests.some((other) => other !== request && isDescendant(request, other, byId))) continue;
      const route = requestRoute(request);
      const members = traceSpans.filter((span) => span === request || isDescendant(span, request, byId));
      if (!routeSamples.has(route)) routeSamples.set(route, { request: [], dbTime: [], bytes: [], fingerprints: new Map() });
      const aggregate = routeSamples.get(route);
      const requestIndex = aggregate.request.length;
      for (const query of aggregate.fingerprints.values()) query.calls.push(0);
      aggregate.request.push(request.timing.durationMs);
      const bodyBytes = numericAttribute(request.attrs, "http.response.body.size", "http.response_content_length");
      if (bodyBytes !== undefined) aggregate.bytes.push(bodyBytes);
      let requestDbTime = 0;
      const perRequest = new Map();
      for (const span of members) {
        const fingerprint = dbFingerprint(span);
        if (!fingerprint) continue;
        requestDbTime += span.timing.durationMs;
        if (!perRequest.has(fingerprint.hash)) perRequest.set(fingerprint.hash, []);
        perRequest.get(fingerprint.hash).push(span.timing.durationMs);
      }
      aggregate.dbTime.push(requestDbTime);
      for (const [hash, durations] of perRequest) {
        if (!aggregate.fingerprints.has(hash)) {
          aggregate.fingerprints.set(hash, { calls: Array(aggregate.request.length).fill(0), times: [] });
        }
        const target = aggregate.fingerprints.get(hash);
        target.calls[requestIndex] = durations.length;
        target.times.push(...durations);
      }
    }

    for (const span of traceSpans) {
      const system = safeName(attribute(span.attrs, "messaging.system"), /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/);
      const queue = safeName(attribute(span.attrs, "messaging.destination.name", "messaging.destination"), /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
      const operation = String(attribute(span.attrs, "messaging.operation.name", "messaging.operation") || "").toLowerCase();
      if (system && queue && /process|receive|consume/.test(operation)) {
        if (!queueSamples.has(queue)) queueSamples.set(queue, { duration: [], wait: [], retries: [] });
        const aggregate = queueSamples.get(queue);
        aggregate.duration.push(span.timing.durationMs);
        const enqueue = timestampMs(attribute(span.attrs, "messaging.message.enqueued_time", "messaging.message.enqueue_time"));
        if (enqueue !== null && span.timing.startMs >= enqueue) aggregate.wait.push(span.timing.startMs - enqueue);
        const delivery = numericAttribute(span.attrs, "messaging.message.delivery_count");
        const retries = numericAttribute(span.attrs, "messaging.message.retry_count");
        if (delivery !== undefined) aggregate.retries.push(delivery > 1 ? 1 : 0);
        else if (retries !== undefined) aggregate.retries.push(retries > 0 ? 1 : 0);
      }

      const cacheSystemRaw = safeName(attribute(span.attrs, "cache.system"), /^[A-Za-z][A-Za-z0-9_.-]{0,31}$/);
      const cacheSystem = cacheSystemRaw && new Set(["redis", "memcached", "database", "file", "array"]).has(cacheSystemRaw.toLowerCase())
        ? cacheSystemRaw.toLowerCase() : cacheSystemRaw ? "other" : null;
      const hit = attribute(span.attrs, "cache.hit");
      if (cacheSystem && (typeof hit === "boolean" || attribute(span.attrs, "cache.operation") !== undefined)) {
        cacheDrivers.add(cacheSystem);
        cacheDurations.push(span.timing.durationMs);
        if (typeof hit === "boolean") cacheHits.push(hit ? 1 : 0);
      }
    }
  }

  const routes = [...routeSamples.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([template, aggregate]) => {
    const route = { template, sampleCount: aggregate.request.length, requestP95Ms: percentile(aggregate.request) };
    if (aggregate.dbTime.length) route.dbTimeP95Ms = percentile(aggregate.dbTime);
    if (aggregate.bytes.length) route.responseBytesP95 = percentile(aggregate.bytes);
    const queryPatterns = [...aggregate.fingerprints.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([hash, values]) => ({
      hash,
      callsPerRequestP95: percentile(values.calls),
      timeP95Ms: percentile(values.times),
    }));
    if (queryPatterns.length) route.queryPatterns = queryPatterns;
    return route;
  });
  const queues = [...queueSamples.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, aggregate]) => {
    const queue = { name, sampleCount: aggregate.duration.length, durationP95Ms: percentile(aggregate.duration) };
    if (aggregate.wait.length) queue.waitP95Ms = percentile(aggregate.wait);
    if (aggregate.wait.length) queue.waitSampleCount = aggregate.wait.length;
    if (aggregate.retries.length) {
      queue.retrySampleCount = aggregate.retries.length;
      queue.retryRate = Number((aggregate.retries.reduce((sum, value) => sum + value, 0) / aggregate.retries.length).toFixed(4));
    }
    return queue;
  });
  const profile = { schemaVersion: 1, environment, routes, queues };
  if (cacheDurations.length && cacheDrivers.size) {
    profile.cache = {
      driver: cacheDrivers.size === 1 ? [...cacheDrivers][0] : "other",
      sampleCount: cacheDurations.length,
      operationWaitP95Ms: percentile(cacheDurations),
    };
    if (cacheHits.length) {
      profile.cache.hitSampleCount = cacheHits.length;
      profile.cache.hitRate = Number((cacheHits.reduce((sum, value) => sum + value, 0) / cacheHits.length).toFixed(4));
    }
  }
  return profile;
}

function importFile(input, environment) {
  const details = fs.statSync(input);
  if (!details.isFile()) throw new Error("Input path is not a file.");
  if (details.size > MAX_INPUT_BYTES) throw new Error("Input exceeds the 32 MiB safety limit.");
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(input, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse OTLP JSON: ${error.message}`);
  }
  return aggregateOtlp(payload, environment);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const profile = importFile(options.input, options.environment);
  const output = `${JSON.stringify(profile, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("Sanitized profile exceeds the 2 MiB profile limit; reduce the trace window or route cardinality.");
  }
  const inputStat = fs.statSync(options.input);
  if (fs.existsSync(options.output)) {
    const outputStat = fs.statSync(options.output);
    if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) {
      throw new Error("Output resolves to the input trace file; refusing to replace source data.");
    }
  }
  fs.writeFileSync(options.output, output, { encoding: "utf8", flag: options.force ? "w" : "wx" });
  process.stdout.write(`Wrote sanitized aggregate profile: ${options.output}\n`);
  process.stdout.write(`Routes: ${profile.routes.length}; queues: ${profile.queues.length}; cache profile: ${profile.cache ? "yes" : "no"}.\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { aggregateOtlp, safeRoute };
