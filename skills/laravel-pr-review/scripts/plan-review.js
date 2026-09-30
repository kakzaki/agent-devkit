"use strict";

const fs = require("node:fs");

const MAX_JSON_BYTES = 20 * 1024 * 1024;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function readJson(file, label) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    throw new Error(`Cannot read ${label} file: ${error.message}`);
  }
  if (size > MAX_JSON_BYTES) throw new Error(`${label} file exceeds the 20 MiB safety limit.`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error.message}`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} must be a plain SQL identifier.`);
}

function validateSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Schema must be an object.");
  const allowed = new Set(["schemaVersion", "engine", "tables"]);
  for (const key of Object.keys(schema)) if (!allowed.has(key)) throw new Error(`Schema contains unsupported field '${key}'; provide metadata only, not DDL or SQL.`);
  if (schema.schemaVersion !== 1 || !["postgresql", "mysql"].includes(schema.engine) || !Array.isArray(schema.tables)) {
    throw new Error("Schema requires schemaVersion 1, engine postgresql|mysql, and a tables array.");
  }
  const tableNames = new Set();
  for (const [tableIndex, table] of schema.tables.entries()) {
    if (!table || typeof table !== "object" || Array.isArray(table)) throw new Error(`tables[${tableIndex}] must be an object.`);
    const keys = new Set(["name", "columns", "indexes", "foreignKeys"]);
    for (const key of Object.keys(table)) if (!keys.has(key)) throw new Error(`tables[${tableIndex}] contains unsupported field '${key}'.`);
    assertIdentifier(table.name, `tables[${tableIndex}].name`);
    const canonicalName = table.name.toLowerCase();
    if (tableNames.has(canonicalName)) throw new Error(`Duplicate table name '${table.name}'.`);
    tableNames.add(canonicalName);
    if (!Array.isArray(table.columns) || !Array.isArray(table.indexes || []) || !Array.isArray(table.foreignKeys || [])) {
      throw new Error(`tables[${tableIndex}] columns, indexes, and foreignKeys must be arrays.`);
    }
    for (const [columnIndex, column] of table.columns.entries()) assertIdentifier(column, `tables[${tableIndex}].columns[${columnIndex}]`);
    for (const [indexIndex, index] of (table.indexes || []).entries()) {
      if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error(`tables[${tableIndex}].indexes[${indexIndex}] must be an object.`);
      for (const key of Object.keys(index)) if (!["name", "columns", "unique", "partial", "functional"].includes(key)) {
        throw new Error(`tables[${tableIndex}].indexes[${indexIndex}] contains unsupported field '${key}'.`);
      }
      assertIdentifier(index.name, `tables[${tableIndex}].indexes[${indexIndex}].name`);
      if (!Array.isArray(index.columns) || index.columns.length === 0 || index.columns.length > 32) throw new Error(`Index ${index.name} requires 1-32 ordered columns.`);
      for (const column of index.columns) assertIdentifier(column, `index ${index.name} column`);
      for (const key of ["unique", "partial", "functional"]) if (index[key] !== undefined && typeof index[key] !== "boolean") {
        throw new Error(`Index ${index.name} field ${key} must be boolean.`);
      }
      if (index.unique === undefined) index.unique = false;
      if (index.partial === undefined) index.partial = false;
      if (index.functional === undefined) index.functional = false;
    }
    for (const [foreignIndex, foreign] of (table.foreignKeys || []).entries()) {
      if (!foreign || typeof foreign !== "object" || Array.isArray(foreign)) throw new Error(`tables[${tableIndex}].foreignKeys[${foreignIndex}] must be an object.`);
      for (const key of Object.keys(foreign)) if (!["name", "columns", "referencedTable", "referencedColumns"].includes(key)) {
        throw new Error(`Foreign key metadata contains unsupported field '${key}'.`);
      }
      if (foreign.name !== undefined) assertIdentifier(foreign.name, "Foreign key name");
      assertIdentifier(foreign.referencedTable, "Foreign key referencedTable");
      if (!Array.isArray(foreign.columns) || !foreign.columns.length || !Array.isArray(foreign.referencedColumns) ||
          foreign.columns.length !== foreign.referencedColumns.length) throw new Error("Foreign key columns must match referencedColumns.");
      for (const column of foreign.columns) assertIdentifier(column, "Foreign key column");
      for (const column of foreign.referencedColumns) assertIdentifier(column, "Referenced column");
    }
  }
  return schema;
}

function safeEstimate(value, label) {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative estimate.`);
  return number;
}

function sanitizePlanIdentifier(value) {
  return typeof value === "string" && value.length <= 64 && /^[A-Za-z_][A-Za-z0-9_$.-]*$/.test(value)
    ? value : undefined;
}

const POSTGRES_NODE_TYPES = new Set([
  "Seq Scan", "Parallel Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan", "Bitmap Index Scan",
  "Tid Scan", "Tid Range Scan", "Subquery Scan", "Function Scan", "Values Scan", "CTE Scan", "WorkTable Scan",
  "Foreign Scan", "Custom Scan", "Nested Loop", "Hash Join", "Merge Join", "Hash", "Sort", "Incremental Sort",
  "Aggregate", "GroupAggregate", "HashAggregate", "Group", "Limit", "Gather", "Gather Merge", "Append",
  "Merge Append", "Parallel Append", "Materialize", "Memoize", "Unique", "SetOp", "WindowAgg", "Result",
  "LockRows", "ModifyTable", "ProjectSet", "Recursive Union", "BitmapAnd", "BitmapOr", "Sample Scan",
  "Table Function Scan", "Named Tuplestore Scan",
]);

function sanitizePostgresNodeType(value) {
  return typeof value === "string" && POSTGRES_NODE_TYPES.has(value) ? value : "Other";
}

function extractPostgresPlan(input) {
  const root = Array.isArray(input) ? input[0] : input;
  const plan = root?.Plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("PostgreSQL plan must be EXPLAIN (FORMAT JSON) output with a Plan object.");
  const nodes = [];
  function visit(node, depth) {
    if (depth > 100 || nodes.length >= 10000) throw new Error("Plan is too deep or contains too many nodes.");
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("PostgreSQL plan node must be an object.");
    const summary = {
      nodeType: sanitizePostgresNodeType(node["Node Type"]),
      relation: sanitizePlanIdentifier(node["Relation Name"]),
      index: sanitizePlanIdentifier(node["Index Name"]),
      rows: safeEstimate(node["Plan Rows"], "Plan Rows"),
      totalCost: safeEstimate(node["Total Cost"], "Total Cost"),
      children: [],
    };
    if (!summary.nodeType) throw new Error("PostgreSQL plan node is missing Node Type.");
    nodes.push(summary);
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans)) throw new Error("PostgreSQL Plans must be an array.");
      summary.children = node.Plans.map((child) => visit(child, depth + 1));
    }
    return summary;
  }
  visit(plan, 0);
  return nodes;
}

function extractMysqlPlan(input) {
  const queryBlock = input?.query_block;
  if (!queryBlock || typeof queryBlock !== "object" || Array.isArray(queryBlock)) {
    throw new Error("MySQL plan must be EXPLAIN FORMAT=JSON output with query_block.");
  }
  const nodes = [];
  function visit(value, depth) {
    if (depth > 100 || nodes.length >= 10000) throw new Error("Plan is too deep or contains too many nodes.");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value.table_name === "string" || typeof value.access_type === "string") {
      const table = sanitizePlanIdentifier(value.table_name);
      const allowedAccess = new Set(["ALL", "index", "range", "index_merge", "ref", "eq_ref", "const", "system", "fulltext", "ref_or_null", "unique_subquery", "index_subquery"]);
      const accessType = value.access_type === undefined ? undefined : String(value.access_type);
      if (accessType !== undefined && !allowedAccess.has(accessType)) throw new Error("MySQL access_type is not a recognized plan operation.");
      const key = sanitizePlanIdentifier(value.key);
      nodes.push({
        nodeType: accessType || "Table Access",
        relation: table,
        index: key,
        rows: safeEstimate(value.rows_examined_per_scan ?? value.rows_produced_per_join, "rows estimate"),
        totalCost: safeEstimate(value.cost_info?.prefix_cost, "prefix_cost"),
        children: [],
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (["table_name", "access_type", "key", "rows_examined_per_scan", "rows_produced_per_join", "cost_info"].includes(key)) continue;
      visit(child, depth + 1);
    }
  }
  visit(queryBlock, 0);
  if (!nodes.length) throw new Error("No table access nodes found in MySQL EXPLAIN JSON.");
  return nodes;
}

function inspectPlan(planInput, engine, rowReviewThreshold = 10000) {
  if (!Number.isFinite(rowReviewThreshold) || rowReviewThreshold < 1) throw new Error("Plan row review threshold must be positive.");
  const nodes = engine === "postgresql" ? extractPostgresPlan(planInput) : engine === "mysql" ? extractMysqlPlan(planInput) : null;
  if (!nodes) throw new Error("Plan engine must be postgresql or mysql.");
  const findings = [];
  for (const node of nodes) {
    const type = node.nodeType.toLowerCase();
    const fullScan = engine === "postgresql" ? type === "seq scan" : type === "all";
    if (fullScan && (node.rows || 0) >= rowReviewThreshold) {
      findings.push({
        rule: "LARGE_SCAN_ESTIMATE",
        severity: "review",
        confidence: "plan-estimate",
        source: "explain",
        location: node.relation || "unknown relation",
        evidence: `${node.nodeType} estimates ${node.rows} rows${node.totalCost === undefined ? "" : ` at planner cost ${node.totalCost}`}.`,
        recommendation: "Review the filter, table size, workload, and representative statistics. A scan is not proof of a missing index; do not add one without validating the query and write/build cost.",
      });
    }
    if (engine === "postgresql" && type === "sort" && (node.rows || 0) >= rowReviewThreshold) {
      findings.push({
        rule: "LARGE_SORT_ESTIMATE",
        severity: "review",
        confidence: "plan-estimate",
        source: "explain",
        location: node.relation || "plan",
        evidence: `Sort node estimates ${node.rows} rows${node.totalCost === undefined ? "" : ` at planner cost ${node.totalCost}`}.`,
        recommendation: "Check the required ordering, result bound, and existing access path. Planner estimates are not observed runtime and do not prove that a new index is beneficial.",
      });
    }
    if (engine === "postgresql" && type === "nested loop" && node.children.length >= 2) {
      const outerRows = node.children[0].rows;
      const innerRows = node.children[1].rows;
      if (outerRows !== undefined && innerRows !== undefined && outerRows * innerRows >= rowReviewThreshold) {
        const estimatedVisits = outerRows * innerRows;
        findings.push({
          rule: "NESTED_LOOP_ESTIMATE_REVIEW",
          severity: "review",
          confidence: "plan-estimate",
          source: "explain",
          location: node.relation || "join plan",
          evidence: `Nested-loop child estimates imply about ${Number((Number.isFinite(estimatedVisits) ? estimatedVisits : Number.MAX_VALUE).toPrecision(6))} inner-row visits before planner/runtime effects.`,
          recommendation: "Inspect join cardinality, predicates, and the inner access path with representative statistics. This is an estimate, not observed work or proof that the join is inefficient.",
        });
      }
    }
  }
  return { engine, nodeCount: nodes.length, nodes, findings, rowReviewThreshold };
}

function inspectSchema(schema) {
  const findings = [];
  let indexCount = 0;
  for (const table of schema.tables) {
    const indexes = table.indexes || [];
    indexCount += indexes.length;
    const seen = new Map();
    for (const index of indexes) {
      if (index.partial || index.functional) continue;
      const key = `${index.unique ? "unique" : "plain"}:${index.columns.map((column) => column.toLowerCase()).join(",")}`;
      if (seen.has(key)) {
        findings.push({
          rule: "DUPLICATE_INDEX_DEFINITION",
          severity: "review",
          confidence: "schema-metadata",
          source: "schema",
          location: `${table.name}.${index.name}`,
          evidence: `A plain index has the same ordered column list as ${seen.get(key)}.`,
          recommendation: "Verify index predicates, collations, visibility, and constraints using the database catalog before considering removal; this metadata format omits engine-specific properties.",
        });
      } else seen.set(key, index.name);
    }
    for (const foreign of table.foreignKeys || []) {
      const hasLeadingIndex = indexes.some((index) => !index.partial && !index.functional &&
        foreign.columns.every((column, position) => index.columns[position]?.toLowerCase() === column.toLowerCase()));
      if (!hasLeadingIndex) {
        findings.push({
          rule: "FOREIGN_KEY_WITHOUT_LEADING_INDEX",
          severity: "review",
          confidence: "schema-metadata",
          source: "schema",
          location: `${table.name} (${foreign.columns.join(", ")})`,
          evidence: "No supplied plain index begins with the foreign-key columns in the same order.",
          recommendation: "Check real catalog metadata and the child-table query workload. A foreign key does not always need an index, and index creation has storage, write, and lock/build costs.",
        });
      }
    }
  }
  return { tableCount: schema.tables.length, indexCount, findings };
}

function loadPlan(file, engine = "auto", rowReviewThreshold = 10000) {
  const payload = readJson(file, "EXPLAIN plan");
  const detected = engine === "auto"
    ? (Array.isArray(payload) || payload?.Plan ? "postgresql" : payload?.query_block ? "mysql" : null)
    : engine;
  if (!detected) throw new Error("Could not infer EXPLAIN engine; use --plan-engine postgresql or mysql.");
  return inspectPlan(payload, detected, rowReviewThreshold);
}

function loadSchema(file) {
  return validateSchema(readJson(file, "schema metadata"));
}

module.exports = { inspectPlan, inspectSchema, loadPlan, loadSchema, validateSchema };
