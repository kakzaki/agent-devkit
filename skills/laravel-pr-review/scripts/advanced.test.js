"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { aggregateOtlp, safeRoute } = require("./import-otel");
const { compareProfiles, exceedsRegressionGate } = require("./profile-compare");
const { inspectPlan, inspectSchema, validateSchema } = require("./plan-review");
const { inspectPhpSource } = require("./php-analysis");

const directory = path.resolve(__dirname);
const importer = path.join(directory, "import-otel.js");
const scanner = path.join(directory, "perf-scan.js");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-devkit advanced "));

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    timeout: 20000,
    windowsHide: true,
  });
}

function attr(key, value, type) {
  const keyName = type || (typeof value === "boolean" ? "boolValue" : typeof value === "number" ? "intValue" : "stringValue");
  return { key, value: { [keyName]: value } };
}

const baseNs = 1704067200000000000n;
const traceId = "a".repeat(32);
const rootSpanId = "1".repeat(16);
function span(spanId, parentSpanId, startOffsetMs, durationMs, attributes, kind = 1, name = "untrusted span name") {
  return {
    traceId,
    spanId,
    parentSpanId,
    kind,
    name,
    startTimeUnixNano: String(baseNs + BigInt(startOffsetMs * 1000000)),
    endTimeUnixNano: String(baseNs + BigInt((startOffsetMs + durationMs) * 1000000)),
    attributes,
  };
}

const otlp = {
  resourceSpans: [{
    resource: { attributes: [attr("service.name", "private-service-name")] },
    scopeSpans: [{ spans: [
      span(rootSpanId, "", 0, 150, [
        attr("http.route", "/api/orders/123456"), attr("http.request.method", "GET"), attr("http.response.body.size", 8192),
      ], 2, "GET /api/orders/123456 email customer@example.test"),
      span("2".repeat(16), rootSpanId, 5, 7, [
        attr("db.system.name", "postgresql"), attr("db.operation.name", "SELECT"), attr("db.namespace", "app"),
        attr("db.collection.name", "orders"), attr("db.statement", "SELECT * FROM orders WHERE email='customer@example.test'"),
      ], 3, "SELECT * FROM orders WHERE email='customer@example.test'"),
      span("3".repeat(16), rootSpanId, 15, 9, [
        attr("db.system.name", "postgresql"), attr("db.operation.name", "SELECT"), attr("db.namespace", "app"),
        attr("db.collection.name", "orders"), attr("db.statement", "private SQL text"),
      ], 3, "private SQL span name"),
      span("4".repeat(16), rootSpanId, 30, 2, [attr("cache.system", "redis"), attr("cache.operation", "get"), attr("cache.hit", true)]),
      span("5".repeat(16), rootSpanId, 32, 3, [attr("cache.system", "redis"), attr("cache.operation", "get"), attr("cache.hit", false)]),
    ] }, {
      spans: [span("6".repeat(16), "", 1000, 25, [
        attr("messaging.system", "redis"), attr("messaging.destination.name", "orders"),
        attr("messaging.operation.name", "process"), attr("messaging.message.enqueued_time", "2024-01-01T00:00:00.000Z"),
        attr("messaging.message.delivery_count", 2),
      ], 1, "Job payload private")],
    }],
  }],
};

try {
  const examples = path.join(directory, "..", "examples");
  const exampleOtlp = JSON.parse(fs.readFileSync(path.join(examples, "otel-traces.example.json"), "utf8"));
  assert.equal(aggregateOtlp(exampleOtlp, "staging").routes.length, 1);
  assert.ok(inspectPlan(JSON.parse(fs.readFileSync(path.join(examples, "postgres-explain.example.json"), "utf8")), "postgresql").nodeCount > 0);
  assert.ok(inspectPlan(JSON.parse(fs.readFileSync(path.join(examples, "mysql-explain.example.json"), "utf8")), "mysql").nodeCount > 0);
  assert.equal(inspectSchema(validateSchema(JSON.parse(fs.readFileSync(path.join(examples, "schema-metadata.example.json"), "utf8")))).tableCount, 1);

  assert.equal(safeRoute("/api/orders/123456"), "/api/orders/{id}");
  assert.equal(safeRoute("/users/customer@example.test"), null);
  const profile = aggregateOtlp(otlp, "staging");
  assert.equal(profile.routes.length, 1);
  assert.equal(profile.routes[0].template, "GET /api/orders/{id}");
  assert.equal(profile.routes[0].sampleCount, 1);
  assert.equal(profile.routes[0].requestP95Ms, 150);
  assert.equal(profile.routes[0].dbTimeP95Ms, 16);
  assert.equal(profile.routes[0].queryPatterns[0].callsPerRequestP95, 2);
  assert.equal(profile.routes[0].responseBytesP95, 8192);
  assert.equal(profile.cache.hitRate, 0.5);
  assert.equal(profile.cache.hitSampleCount, 2);
  assert.equal(profile.queues[0].waitP95Ms, 1000);
  assert.equal(profile.queues[0].waitSampleCount, 1);
  assert.equal(profile.queues[0].retryRate, 1);
  assert.equal(profile.queues[0].retrySampleCount, 1);
  const sparseTraces = structuredClone(otlp);
  for (let index = 0; index < 19; index++) {
    sparseTraces.resourceSpans[0].scopeSpans[0].spans.push(span(
      (index + 10).toString(16).padStart(16, "0"), "", 200 + index * 200, 20,
      [attr("http.route", "/api/orders/123456"), attr("http.request.method", "GET")], 2
    ));
  }
  const sparseProfile = aggregateOtlp(sparseTraces, "staging");
  assert.equal(sparseProfile.routes[0].sampleCount, 20);
  assert.equal(sparseProfile.routes[0].dbTimeP95Ms, 0, "requests without DB spans count as zero work in route p95");
  assert.equal(sparseProfile.routes[0].queryPatterns[0].callsPerRequestP95, 0, "query call p95 includes requests with no matching query");
  const sanitized = JSON.stringify(profile);
  for (const secret of ["customer@example.test", "private SQL", "private-service-name", "private span name", "Job payload private"]) {
    assert.ok(!sanitized.includes(secret), `import output leaked ${secret}`);
  }

  const otlpFile = path.join(temp, "traces.json");
  const profileFile = path.join(temp, "current-profile.json");
  fs.writeFileSync(otlpFile, JSON.stringify(otlp), "utf8");
  const imported = run(importer, [otlpFile, "--environment", "staging", "--output", profileFile]);
  assert.equal(imported.status, 0, imported.stderr);
  const importedText = fs.readFileSync(profileFile, "utf8");
  assert.ok(!importedText.includes("customer@example.test"));
  assert.ok(!importedText.includes("private-service-name"));
  assert.equal(run(importer, [otlpFile, "--output", profileFile]).status, 2, "refuse accidental output overwrite");
  assert.equal(run(importer, [otlpFile, "--output", otlpFile, "--force"]).status, 2, "never replace the trace input");

  const baseline = structuredClone(profile);
  baseline.routes[0].requestP95Ms = 100;
  baseline.routes[0].dbTimeP95Ms = 10;
  baseline.routes[0].queryPatterns[0].callsPerRequestP95 = 1;
  baseline.queues[0].retryRate = 0;
  const comparison = compareProfiles(baseline, profile);
  assert.ok(comparison.regressionCount >= 3);
  assert.equal(exceedsRegressionGate(comparison, 10), true);
  assert.equal(exceedsRegressionGate({ comparedMetricCount: 0, metrics: [] }, 10), true, "gate fails closed when there are no matching metrics");

  const app = path.join(temp, "app");
  fs.mkdirSync(app);
  const exampleProfileScan = run(scanner, [app, "--profile", path.join(examples, "performance-profile.example.json"), "--json"]);
  assert.equal(exampleProfileScan.status, 0, exampleProfileScan.stderr);
  assert.equal(JSON.parse(exampleProfileScan.stdout).profile.routeCount, 1);
  const baselineFile = path.join(temp, "baseline.json");
  fs.writeFileSync(baselineFile, JSON.stringify(baseline), "utf8");
  const report = run(scanner, [app, "--profile", profileFile, "--baseline", baselineFile, "--markdown", "--fail-on-regression", "10"]);
  assert.equal(report.status, 1, `expected regression gate failure: ${report.stdout}\n${report.stderr}`);
  assert.match(report.stdout, /Baseline comparison/);
  assert.match(report.stdout, /Regression/);

  const planFile = path.join(temp, "postgres-plan.json");
  const schemaFile = path.join(temp, "schema.json");
  const mysqlSchemaFile = path.join(temp, "mysql-schema.json");
  fs.writeFileSync(planFile, JSON.stringify([{ Plan: {
    "Node Type": "Seq Scan", "Relation Name": "orders", "Plan Rows": 25000, "Total Cost": 900,
  } }]), "utf8");
  fs.writeFileSync(schemaFile, JSON.stringify({ schemaVersion: 1, engine: "postgresql", tables: [] }), "utf8");
  fs.writeFileSync(mysqlSchemaFile, JSON.stringify({ schemaVersion: 1, engine: "mysql", tables: [] }), "utf8");
  const planReport = run(scanner, [app, "--plan", planFile, "--schema", schemaFile, "--markdown"]);
  assert.equal(planReport.status, 0, planReport.stderr);
  assert.match(planReport.stdout, /EXPLAIN: postgresql/);
  assert.match(planReport.stdout, /LARGE\\_SCAN\\_ESTIMATE/);
  const engineMismatch = run(scanner, [app, "--plan", planFile, "--schema", mysqlSchemaFile]);
  assert.equal(engineMismatch.status, 2);
  assert.match(engineMismatch.stderr, /engines must match/);

  const postgres = inspectPlan([{ Plan: {
    "Node Type": "Seq Scan", "Relation Name": "orders", "Startup Cost": 0,
    "Total Cost": 900, "Plan Rows": 25000, Filter: "email = 'customer@example.test'",
    Plans: [{ "Node Type": "Sort", "Plan Rows": 25000, "Total Cost": 800, "Sort Key": ["private_column"] }],
  } }], "postgresql", 10000);
  assert.ok(postgres.findings.some((finding) => finding.rule === "LARGE_SCAN_ESTIMATE"));
  assert.ok(postgres.findings.some((finding) => finding.rule === "LARGE_SORT_ESTIMATE"));
  assert.ok(!JSON.stringify(postgres).includes("customer@example.test"));
  assert.ok(!JSON.stringify(postgres).includes("private_column"));

  const mysql = inspectPlan({ query_block: { nested_loop: [{ table: {
    table_name: "orders", access_type: "ALL", rows_examined_per_scan: 50000,
    attached_condition: "email='customer@example.test'",
  } }] } }, "mysql", 10000);
  assert.ok(mysql.findings.some((finding) => finding.rule === "LARGE_SCAN_ESTIMATE"));
  assert.ok(!JSON.stringify(mysql).includes("customer@example.test"));

  const schema = validateSchema({
    schemaVersion: 1,
    engine: "postgresql",
    tables: [{
      name: "orders", columns: ["id", "customer_id", "tenant_id"],
      indexes: [
        { name: "orders_customer_idx", columns: ["customer_id"], unique: false },
        { name: "orders_customer_dup", columns: ["customer_id"], unique: false },
      ],
      foreignKeys: [{ name: "orders_tenant_fk", columns: ["tenant_id"], referencedTable: "tenants", referencedColumns: ["id"] }],
    }],
  });
  const schemaReport = inspectSchema(schema);
  assert.ok(schemaReport.findings.some((finding) => finding.rule === "DUPLICATE_INDEX_DEFINITION"));
  assert.ok(schemaReport.findings.some((finding) => finding.rule === "FOREIGN_KEY_WITHOUT_LEADING_INDEX"));
  assert.throws(() => validateSchema({ schemaVersion: 1, engine: "mysql", tables: [], ddl: "DROP TABLE orders" }), /unsupported field 'ddl'/);

  const php = `<?php
// foreach ($ignored as $x) { DB::table('fake')->get(); }
$message = "foreach ($alsoIgnored as $x) { DB::table('fake')->get(); }";
foreach ($orders as $order) {
    $query = OrderLine::query()
        ->where('order_id', $order->id)
        ->first();
    $customer = $order->customer;
}
$bounded = Event::query()
    ->limit(25)
    ->get();
$page = Order::paginate(
    $request->input('per_page')
);
$raw = DB::select(<<<'SQL'
SELECT * FROM invoices
SQL);
`;
  const phpFindings = inspectPhpSource(php, temp, path.join(temp, "Orders.php"));
  const phpRules = new Set(phpFindings.map((finding) => finding.rule));
  assert.ok(phpRules.has("DATABASE_CALL_IN_LOOP"));
  assert.ok(phpRules.has("RELATION_ACCESS_IN_LOOP"));
  assert.ok(phpRules.has("UNBOUNDED_PAGE_SIZE_INPUT"));
  assert.ok(phpRules.has("RAW_SELECT_STAR"));
  assert.ok(!phpRules.has("COLLECTION_GET_WITHOUT_VISIBLE_BOUND"), "bounded multiline get should not be flagged");
  assert.equal(phpFindings.length, 4, "comment and string examples should not be analyzed as PHP code");
  const inlineHtml = `<!doctype html><div>foreach ($items as $item) { DB::table('fake')->get(); }</div>
<?php $safe = true; ?>
<script>while ($unsafe) { query(); }</script>`;
  assert.equal(inspectPhpSource(inlineHtml, temp, path.join(temp, "view.php")).length, 0, "inline HTML is not parsed as PHP");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("Advanced Laravel performance tests passed.\n");
