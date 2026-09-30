---
name: pre-push-review
description: Inspect staged, unstaged, or explicitly selected local changes before commit or push. Report substantiated security, correctness, performance, and maintainability risks without changing files.
---

# Local Change Check

Review the user's requested diff scope. Default to staged plus unstaged tracked changes; include untracked files only when they are explicitly available for review. Do not stage, modify, commit, or push anything.

## Method

1. State the exact scope and base being reviewed. If the base is missing or ambiguous, ask or record the limitation.
2. Read surrounding code for changed behavior and likely callers; focus on reachable risks, not style preferences.
3. Check input boundaries, permissions, data handling, failure behavior, tests, resource use, and compatibility.
4. Run existing non-destructive checks only when their purpose and environment are clear. Verify database-test isolation first; if uncertain, skip.
5. Report findings before positive notes. Include a clear push recommendation based on evidence, not finding count.

## Finding quality

Each finding needs a location, reproducible or traceable evidence, impact, and practical correction. Distinguish confirmed defects from assumptions. Do not repeat secret values or sensitive records in the report. Avoid claiming latency or memory gains without measurement.

## Output

Provide a concise summary, findings ordered by severity, checks run/skipped, and open risks. Use **Ready**, **Ready with cautions**, or **Hold** for the recommendation. This is a review, not a guarantee that the complete system is safe.
