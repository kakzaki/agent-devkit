---
name: nextjs-pr-review
description: Review Next.js and React changes for correctness, application security, accessibility, and runtime cost. Use for diffs involving routes, server/client boundaries, data fetching, caching, or browser behavior.
---

# Next.js Change Review

Review the requested changes without editing them unless implementation is explicitly requested. Identify the installed framework and React versions from manifests and lockfiles; do not assume that a feature exists in every version.

## Walk the execution path

- Trace route entry points through layouts, server components, client components, actions, handlers, data access, and serialization.
- Check which code executes on the server and which is shipped to the browser. Verify that secrets and privileged data stay server-side.
- Follow authentication, authorization, tenant scoping, input validation, output encoding, redirects, and error paths at each reachable entry point.
- Review cache boundaries for user/tenant isolation, invalidation, and stale-data behavior.
- Inspect parallel and sequential fetches, duplicated work, hydration cost, large client dependencies, and accessible interaction states.

## Safe validation

Run only existing checks that are low risk and relevant to the diff. Before tests or scripts that may access a database, verify that their configuration points to a disposable isolated test target without displaying secret values. Never run migrations or data resets against a live target. If isolation is uncertain, skip the check and explain why.

Record the exact command and result. Do not claim a build, browser test, or performance measurement passed if it was not run.

## Report

List actionable findings with severity, file/line, evidence, user or security impact, and a narrow fix. Mark performance claims inferred from code as unmeasured. End with checks run, skipped checks, and material assumptions. Do not approve, merge, or deploy on the user's behalf.
