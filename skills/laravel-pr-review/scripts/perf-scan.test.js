"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "perf-scan.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "laravel-perf-check "));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
}

try {
  const app = path.join(temp, "app");
  fs.mkdirSync(path.join(app, "app", "Http"), { recursive: true });
  fs.mkdirSync(path.join(app, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(app, ".env"), "DB_PASSWORD=must-not-be-read\n", "utf8");
  fs.writeFileSync(path.join(app, "vendor", "ignored.php"), "<?php DB::table('x')->get();", "utf8");
  fs.writeFileSync(path.join(app, "app", "Http", "Orders.php"), `<?php
foreach ($orders as $order) {
    $customer = $order->customer;
    $line = DB::table('order_lines')->where('order_id', $order->id)->first();
}
$events = DB::table('events')->get();
$exists = User::where('active', true)->count() > 0;
$raw = DB::select('SELECT * FROM invoices');
$page = Order::paginate(request()->input('per_page'));
`, "utf8");

  const staticResult = run([app, "--json"]);
  assert.equal(staticResult.status, 0, staticResult.stderr);
  const staticReport = JSON.parse(staticResult.stdout);
  const rules = new Set(staticReport.findings.map((finding) => finding.rule));
  for (const expected of [
    "DATABASE_CALL_IN_LOOP",
    "RELATION_ACCESS_IN_LOOP",
    "COLLECTION_GET_WITHOUT_VISIBLE_BOUND",
    "COUNT_USED_AS_BOOLEAN",
    "RAW_SELECT_STAR",
    "UNBOUNDED_PAGE_SIZE_INPUT",
  ]) assert.ok(rules.has(expected), `missing static candidate ${expected}`);
  assert.equal(staticReport.scannedPhpFiles, 1, "dependency and hidden configuration files are excluded");
  assert.ok(!staticResult.stdout.includes("must-not-be-read"));

  const profilePath = path.join(temp, "metrics.json");
  fs.writeFileSync(profilePath, JSON.stringify({
    schemaVersion: 1,
    environment: "staging",
    routes: [{
      template: "GET /api/orders/{order}",
      sampleCount: 50,
      requestP95Ms: 2400,
      dbTimeP95Ms: 840,
      dbWaitP95Ms: 70,
      responseBytesP95: 300000,
      cpuP95Ms: 650,
      memoryBytesP95: 140000000,
      queryPatterns: [{ hash: "0123456789abcdef", callsPerRequestP95: 9, timeP95Ms: 220 }],
    }],
    queues: [{ name: "orders", sampleCount: 30, waitP95Ms: 7000, durationP95Ms: 12000, retryRate: 0.1 }],
    cache: { driver: "redis", sampleCount: 100, hitRate: 0.4, operationWaitP95Ms: 3, evictionsPerMinuteP95: 0 },
    runtime: { pool: "octane", sampleCount: 70, workerMemoryBytesP95: 300000000, workerBusyRatioP95: 0.94, dbConnectionUtilizationP95: 0.9 },
    thresholds: { cacheHitRateMin: 0.8 },
  }), "utf8");
  const measured = run([app, "--profile", profilePath, "--json"]);
  assert.equal(measured.status, 0, measured.stderr);
  const report = JSON.parse(measured.stdout);
  assert.equal(report.profile.environment, "staging");
  assert.ok(report.findings.some((finding) => finding.rule === "ROUTE_LATENCY_P95" && finding.severity === "high"));
  assert.ok(report.findings.some((finding) => finding.rule === "REPEATED_QUERY_PATTERN"));
  assert.ok(report.findings.some((finding) => finding.rule === "QUEUE_RETRY_RATE"));
  assert.ok(report.findings.some((finding) => finding.rule === "CACHE_HIT_RATE"));
  assert.ok(report.findings.some((finding) => finding.rule === "WORKER_BUSY_RATIO_P95"));
  assert.ok(report.findings.some((finding) => finding.rule === "DB_CONNECTION_UTILIZATION_P95"));
  assert.ok(!measured.stdout.includes("SELECT * FROM"));

  const unsafeProfile = path.join(temp, "unsafe.json");
  fs.writeFileSync(unsafeProfile, JSON.stringify({
    schemaVersion: 1,
    environment: "production",
    routes: [],
    queues: [],
    sql: "SELECT * FROM private_records",
  }), "utf8");
  const rejected = run([app, "--profile", unsafeProfile]);
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /unsupported field 'sql'/);

  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /makes no network or database connections/i);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("Laravel performance scanner tests passed.\n");
