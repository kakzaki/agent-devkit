---
name: laravel-pr-review
description: Inspect Laravel and PHP changes for correctness, security, maintainability, and backend performance. Use for Laravel pull requests, changed files, or requests about slow endpoints, Eloquent queries, queues, and PHP runtime behavior.
---

# Laravel Change Review

Review the requested diff and report actionable findings. Do not edit application files unless the user separately requests implementation. Tie every claim to a changed line or supplied measurement; do not invent query counts, latency, or memory use.

## Review sequence

1. Confirm the requested scope (PR, branch, staged files, or local diff). Read the package manifests and framework configuration to identify versions; do not print secret values from environment files.
2. Trace each changed route, controller, job, event listener, model, policy, and data-access call into its callers and response shape.
3. Check input validation, authorization at the operation boundary, tenant scoping, mass assignment, output encoding, and exception handling.
4. Assess the performance paths below where relevant. Separate measured facts from code-based hypotheses.
5. Run only low-risk existing checks. Before any test that may use a database, verify from configuration structure (without exposing credentials) that it uses an isolated disposable database. Skip it if uncertain.
6. Return findings first, sorted by impact, followed by verification, assumptions, and open questions.

## Backend performance review

| Concern | Look for | Safer recommendation pattern |
|---|---|---|
| N+1 reads | Relationship access inside loops, serializers, templates, or policies | Eager-load only the relations used on this path; constrain nested relations and use aggregate helpers where rows themselves are unnecessary |
| Slow queries | Repeated database spans, broad scans, sorting large result sets, or query timings supplied by the user | Correlate a trace with the exact query and workload. Use a plan from an isolated representative environment; do not run `EXPLAIN ANALYZE` on production as a casual check |
| Index design | New filters, sort keys, joins, tenant keys, and foreign keys | Check existing indexes and query order. Propose a narrow index whose leading columns match the access pattern; discuss write cost, size, selectivity, and engine-specific online-build behavior |
| JOIN quality | Joins that multiply rows, ambiguous keys, avoidable per-row subqueries, or fetching columns not consumed | State the expected row grain on each side, preserve authorization predicates, and select only required fields. Do not replace a join without proving the result shape remains equivalent |
| Over-fetching | `*`, unbounded collection materialization, oversized nested resources | Select required columns and return bounded pages. Choose offset or cursor pagination based on ordering, deep-page behavior, and API compatibility |
| Eloquent loading | Lazy relation access after the initial query, repeated count/sum work | Load relations at the query boundary, preserve relation constraints, and prefer database aggregates when only totals or existence are needed |
| Caches and Redis | Repeated deterministic reads, missing invalidation, shared keys for personalized data, unbounded key growth | Cache only when staleness is acceptable. Include tenant/user scope in private keys; define TTL and invalidation. Consider eviction policy, memory budget, serialization, and whether locks can queue requests |
| API payloads | Large nested resources, hidden fields, redundant representations | Measure representative encoded size; return fields needed by the client and paginate collections. Preserve authorization and avoid breaking established clients |
| CPU and loops | Repeated parsing, quadratic collection work, expensive work inside a request | Reduce duplicate work, use keyed lookups or batching, and move suitable work to a queue. Verify a profile before proposing algorithm or infrastructure changes |
| Memory | Loading full tables, retaining large collections, worker growth | Stream or process bounded chunks with a stable key. Account for transaction duration, cursor lifetime, and cleanup on failure |
| Queues | Work better suited to background execution, retries duplicating effects, overlapping jobs | Make handlers idempotent, set realistic timeouts/retry limits, define unique/overlap rules, and expose failure/dead-letter behavior. Preserve user-visible consistency |
| HTTP/API latency | Sequential remote calls, slow dependencies, missing timeouts, oversized responses | Attribute time by span before optimizing. Bound external calls, reuse safe clients, parallelize only independent requests, and return a smaller stable payload |
| Octane / PHP-FPM | Request-specific state retained in long-lived workers, worker memory growth, mismatched pool sizing | Keep mutable request data out of singletons/static state under Octane. For FPM, derive worker limits from measured process memory and host capacity; do not prescribe a universal pool size |
| DB connections | Connections opened repeatedly, long transactions, pool saturation, too many workers for DB capacity | Reuse framework-managed connections, end transactions promptly, and compare application concurrency with the database's connection budget. Do not increase pool size as a substitute for finding contention |

## Optional local scanner

Run the bundled static check from the application root:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js .
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . --json
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . --markdown
```

The scanner reads PHP source without executing it, skips dependency/build/storage folders and symbolic links, makes no network or database connections, and writes nothing. Its tokenizer distinguishes code from comments and string literals and tracks common loop blocks and query chains; this is a lightweight structural scan, **not a complete PHP AST or proof of runtime behavior**. Findings are review candidates, not confirmed defects. It can point out query-shaped calls in `foreach`/`for`/`while` loops, possible relation reads in loops, collection materialization without a nearby bound, raw `SELECT *`, boolean checks based on `count()`, and page sizes passed directly from request input.

### Optional staged-file pre-commit warning

To run the same static checks against **staged PHP content only** before local commits, install the warning-only hook from the Laravel repository:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/git-hook.js install --root .
# Remove it later:
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/git-hook.js uninstall --root .
```

The hook reads blobs from Git's index, so unstaged edits are neither scanned nor included. It does not overwrite an existing `pre-commit` hook; if one exists, compose the checks yourself rather than replacing it. Uninstall removes only the exact, unchanged hook generated by this installer. Findings are heuristic warnings and never block commits; scanner errors also allow the commit to continue. For required regression checks, prefer CI.

### Import an OTLP trace export

The importer accepts an explicitly supplied **OpenTelemetry Protocol JSON traces export** (`resourceSpans`) and emits the existing aggregate profile format. It is an offline file transform—not an APM connection or telemetry collector:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/import-otel.js ./traces.json \
  --environment staging --output ./performance-current.json
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . \
  --profile ./performance-current.json --markdown
```

The importer only copies validated route templates, HTTP method, response-size numbers, logical queue names, and explicitly supported cache/DB semantic attributes. It hashes database system/operation/table categories; it never writes span names, IDs, SQL statements, arbitrary attributes, request values, or payloads to the profile. Numeric/UUID route segments are normalized; unsafe route labels are skipped. Output files are not overwritten unless `--force` is explicitly passed. Keep the original trace export protected: importing does not scrub or delete that input.

The importer calculates nearest-rank p95 from span samples and records separate sample counts when queue-wait, retry, or cache-hit data is present only on a subset of spans. `dbTimeP95Ms` is the p95 of the **sum of child DB span durations per request**, so parallel spans may make it exceed request wall time. Queue wait is derived only when a span has an explicit ISO-8601 enqueue timestamp; retry rate only when a delivery/retry count attribute is present. Cache hit ratio requires an explicit `cache.hit` boolean. The importer does not infer PHP-FPM/Octane memory, Redis eviction, connection utilization, or Horizon state from traces; supply those aggregate fields through a profile when independently measured.

### Review offline EXPLAIN and schema metadata

Pass a saved PostgreSQL `EXPLAIN (FORMAT JSON)` or MySQL `EXPLAIN FORMAT=JSON` document and, optionally, a metadata-only schema file:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . \
  --plan ./sanitized-explain.json --schema ./schema-metadata.json --markdown
```

The reader does not connect to a database and does not execute or generate SQL. It reports estimated large scans for PostgreSQL/MySQL, plus PostgreSQL sort and nested-loop child estimates, as review prompts. Predicate text, output expressions, and other raw EXPLAIN fields are not copied into the report. Estimated rows/cost are not observed latency. The schema JSON only accepts table/column/index/foreign-key names and simple metadata; it can flag duplicate plain index definitions or foreign keys without a supplied leading index. It cannot model every engine feature (such as predicates, collations, included columns, visibility, or constraints), so verify findings against an authorized catalog export before any change. Example inputs: [PostgreSQL plan](examples/postgres-explain.example.json), [MySQL plan](examples/mysql-explain.example.json), [schema metadata](examples/schema-metadata.example.json).

### Compare a baseline

Compare two validated aggregate profiles by matching route templates, queue names, and query fingerprints:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . \
  --profile ./performance-current.json --baseline ./performance-before.json \
  --markdown --fail-on-regression 10
```

The command exits with status 1 when a matched metric regresses by at least the given percentage. It fails closed if no metrics match. Added/removed routes and queues are reported but are not automatically classified as regressions. Ratios are compared as percentages of their stored values; choose comparable environments, traffic windows, sample sizes, and instrumentation before trusting the result. Thresholds in the regular profile scan are review prompts, not service-level objectives.

The aggregate profile schema is demonstrated in [examples/performance-profile.example.json](examples/performance-profile.example.json). Durations are milliseconds, sizes are bytes, ratios are from 0 to 1, and each aggregate includes its sample count. It can also include externally measured queue, cache, worker-memory, saturation, and database-connection aggregates. Never include SQL text, request bodies, credentials, user IDs, or raw production rows. The tool only reads supplied files; it does not collect telemetry. Cache hit-ratio findings are opt-in through `thresholds.cacheHitRateMin` because not every cache workload has the same expected ratio.

## Evidence and safety rules

- Prefer profiler traces, sampled query logs, sanitized plans, and before/after tests supplied by the user. Mark static suspicions as **unmeasured**.
- Do not request production dumps, secrets, raw customer rows, or credentials. Ask for schema and synthetic examples instead.
- Never connect to a live database, apply a migration, change cache state, run a production load test, or alter deployment settings as part of review.
- Never recommend caching as the first response to a slow query without understanding query cost, freshness, and invalidation.
- Do not treat adding an index as free: include lock/build risk, disk use, write amplification, and the exact query it is intended to serve.
- Database-aware tests and migration checks require an isolated disposable target. Read-only agent mode is not a database permission control.

## Finding format

For each issue include **severity**, **file and line**, **evidence**, **impact**, **recommended change**, and **verification**. State whether the issue is measured or inferred. Close with checks run/skipped and any missing production-like evidence. If no finding is supported, say so without inventing one.
