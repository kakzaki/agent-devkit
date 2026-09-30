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
```

It scans PHP files only (plus the explicitly named JSON profile, when used), skips dependency/build/storage folders and symbolic links, makes no network or database connections, and writes nothing. Its findings are **review candidates**, not confirmed defects. It can point out query-shaped calls inside loops, possible relation reads in loops, collection materialization without a nearby bound, raw `SELECT *`, boolean checks based on `count()`, and page sizes passed directly from request input. The code cannot tell from PHP alone whether an index is missing or a join is slow.

For measurements already collected by an approved profiler, pass a sanitized aggregate JSON file with `--profile`. The schema is demonstrated in [examples/performance-profile.example.json](examples/performance-profile.example.json). Durations are milliseconds, sizes are bytes, ratios are from 0 to 1, and each aggregate includes its sample count. It can summarize route latency/payload, normalized query fingerprints, queue wait/retry, cache backend behavior, worker memory/saturation, and database-connection utilization. Use route templates and hexadecimal query fingerprints only—never include SQL text, request bodies, credentials, user IDs, or raw production rows. The tool only reads the supplied file; it does not collect telemetry. Built-in thresholds are review prompts, not service-level objectives, and may be overridden in the profile; cache hit-ratio findings are opt-in through `thresholds.cacheHitRateMin` because not every cache has the same expected workload.

## Evidence and safety rules

- Prefer profiler traces, sampled query logs, sanitized plans, and before/after tests supplied by the user. Mark static suspicions as **unmeasured**.
- Do not request production dumps, secrets, raw customer rows, or credentials. Ask for schema and synthetic examples instead.
- Never connect to a live database, apply a migration, change cache state, run a production load test, or alter deployment settings as part of review.
- Never recommend caching as the first response to a slow query without understanding query cost, freshness, and invalidation.
- Do not treat adding an index as free: include lock/build risk, disk use, write amplification, and the exact query it is intended to serve.
- Database-aware tests and migration checks require an isolated disposable target. Read-only agent mode is not a database permission control.

## Finding format

For each issue include **severity**, **file and line**, **evidence**, **impact**, **recommended change**, and **verification**. State whether the issue is measured or inferred. Close with checks run/skipped and any missing production-like evidence. If no finding is supported, say so without inventing one.
