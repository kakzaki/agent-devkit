# Agent DevKit

Agent DevKit is a toolkit of reusable instructions for coding agents. Its skills focus on evidence-based engineering work, bounded actions, and safety checks that do not depend on a prompt being a security boundary.

## Skills

| Skill | Purpose |
|---|---|
| `laravel-pr-review` | Review Laravel changes, including query, API, worker, and runtime performance |
| `production-db-safety` | Assess database plans without connecting to or changing a database |
| `web-perf-audit` | Diagnose website performance using evidence that is actually available |
| `nextjs-pr-review` | Review Next.js changes for correctness, safety, and user-visible cost |
| `pre-push-review` | Inspect local changes before they are committed or pushed |
| `technical-seo-geo-audit` | Review discoverability and page information quality |
| `code-architecture-drawer` | Map code boundaries and explain dependencies from repository evidence |
| `comment-cleanup` | Remove comments that are misleading or no longer useful |
| `rephrase-code-comments` | Make code comments easier to understand without changing their meaning |
| `delegate` | Prepare a task for a tool explicitly chosen by the user |

## Install

Requires Node.js 18+. Clone this repository, then run commands from the repository directory:

```powershell
git clone https://github.com/kakzaki/agent-devkit.git
cd agent-devkit
node bin/cli.js list
node bin/cli.js install laravel-pr-review production-db-safety --project --root C:\path\to\app --opencode
```

The default target is Claude Code and Codex. Choose one with `--claude`, `--codex`, or `--opencode`; combine targets with `--all-clients`. Use `--user` for your home directory or `--project --root <path>` for a repository. Pass `--all` only when you intend to install every skill.

```powershell
node bin/cli.js where laravel-pr-review production-db-safety --project --root C:\path\to\app --opencode
node bin/cli.js uninstall laravel-pr-review production-db-safety --project --root C:\path\to\app --opencode
```

The installer only touches the named skill directories. It stages a full copy before replacing an existing skill and attempts to restore the previous copy if the replacement fails.

### Install by asking your agent

Open the Laravel project in your coding-agent harness and copy this prompt into its chat:

```text
I'm in the root of a Laravel project. Install both `laravel-pr-review` and `production-db-safety` from the official Agent DevKit repository at https://github.com/kakzaki/agent-devkit. Use its official `bin/cli.js` installer. If Agent DevKit isn't available locally, clone it outside this project. Detect the active supported harness and use its matching flag (`--claude`, `--codex`, or `--opencode`). Resolve this Laravel project's absolute path before running the installer. Install only these two skills at project scope, then verify both with the installer's `where` command. Do not edit application files, run database commands, or install a Git hook. Report the installed directories.
```

The agent still needs Node.js 18+ and permission to run the installer. If the skills don't appear afterward, reload the project or start a new agent session.

## Mini tutorial: use both Laravel skills

A skill is a set of instructions the agent reads; you don't run `SKILL.md` yourself. Open the project in your harness and explicitly name both skills when the task could involve database changes. For example, copy and adapt this prompt:

```text
Use `laravel-pr-review` to audit [HTTP METHOD + route or Controller@action] in this Laravel project. Trace the request to its database operations, including Eloquent, query builder, and raw SQL calls such as DB::select, whereRaw, selectRaw, orderByRaw, and DB::raw. For each important query, assess bindings versus interpolation, filters, joins, selected columns, result limits/pagination, repeated queries, and whether available schema/index details support the query shape. Say what looks efficient, what is only a hypothesis, and what cannot be confirmed from code. If you need more evidence, ask me for sanitized SQL/bindings, database engine/version, schema/index metadata, profiler data, or a saved non-production EXPLAIN plan. If you recommend an index, migration, or schema change, also use `production-db-safety` to review its risks. Review only: do not connect to a database, run SQL or EXPLAIN ANALYZE, execute migrations, alter tables, or deploy changes. Cite files and lines, and separate measured evidence from hypotheses.
```

`laravel-pr-review` reviews application code and performance; `production-db-safety` reviews proposed database operations but never executes them. For an endpoint audit, provide the HTTP method and route or controller action. Skill selection depends on the harness, so explicitly naming both is more reliable than expecting automatic chaining. These skills are guidance, not technical access controls—production protection must also come from database permissions and the deployment process.

Other phrases that may activate `laravel-pr-review` include “review Laravel performance”, “why is this endpoint slow?”, “check for N+1”, or “optimasi performa Laravel”. It reports findings and doesn't edit application code unless you ask it to.

## Laravel performance check

The Laravel skill includes an optional static scanner. Run it from the Laravel app root:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js .
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/import-otel.js ./traces.json --environment staging --output ./profile.json
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . --profile ./profile.json --baseline ./baseline.json --markdown --fail-on-regression 10
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . --plan ./explain.json --schema ./schema.json --markdown
```

It can statically inspect PHP source, import an offline OpenTelemetry JSON trace export into sanitized aggregates, compare profiles, and review saved PostgreSQL/MySQL plans plus metadata-only schemas. The source scanner uses heuristics and does not fully analyze arbitrary raw SQL or prove a query is optimized. It never connects to a database or service, executes SQL, or measures the application itself. See the skill guide for format examples, limits, and evidence requirements.

Install the optional local pre-commit warning in a Laravel repository, then remove it when no longer needed:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/git-hook.js install --root .
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/git-hook.js uninstall --root .
```

The hook checks only staged PHP blobs from the Git index—not unstaged worktree contents. Findings and scanner errors are warnings; commits continue. Installation refuses to overwrite an existing hook, and uninstall removes only an unchanged Agent DevKit hook. This is a local convenience; CI is the better place for any required regression gate.

## Safety boundaries

Skills are guidance, not access controls. Enforce permissions in the operating system, database, network proxy, or execution service. The database safety skill is review-only: it must not connect to a database or run queries. Verify that database-aware tests use an isolated disposable target; avoid unapproved load tests against live services; do not put secrets in prompts or reports.

## Development

```sh
npm test
node bin/cli.js list
```

The installer and tests use Node.js built-ins; no dependency installation is needed.

## License

MIT. See [LICENSE](LICENSE).
