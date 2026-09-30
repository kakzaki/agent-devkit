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
node bin/cli.js where laravel-pr-review --project --root C:\path\to\app --opencode
node bin/cli.js uninstall laravel-pr-review --project --root C:\path\to\app --opencode
```

The installer only touches the named skill directories. It stages a full copy before replacing an existing skill and attempts to restore the previous copy if the replacement fails.

## Laravel performance check

The Laravel skill includes an optional static scanner. Run it from the Laravel app root:

```sh
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js .
node /path/to/agent-devkit/skills/laravel-pr-review/scripts/perf-scan.js . --profile ./sanitized-profile.json --json
```

It flags source patterns for manual review and can summarize sanitized aggregate metrics. It does not connect to a database or service, execute SQL, or measure the application itself. See the skill guide for its input limits and evidence requirements.

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
