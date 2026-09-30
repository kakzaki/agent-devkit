---
name: comment-cleanup
description: Review comments and docstrings for stale, misleading, or redundant text. Use when asked to clean comments while preserving executable behavior and important rationale.
---

# Comment Maintenance

Treat comments as part of the interface to future maintainers. First inspect the surrounding code and the user's requested paths. Do not perform a repository-wide edit unless the user names that scope.

## Keep, revise, or remove

- Keep rationale that explains a non-obvious constraint, security choice, compatibility edge, or operational hazard.
- Update factual statements that no longer match behavior.
- Remove text that only paraphrases the next line, has become obsolete, or contains a completed TODO with no tracking value.
- Do not remove copyright/license notices, generated-file headers, public API documentation, or warning comments without explicit authorization and context.
- Do not alter executable code, identifiers, formatting outside the requested comment, or behavior.

## Workflow

Summarize proposed changes by file before editing. When edits are authorized, make the smallest change, then inspect the diff to prove only comments/docstrings changed. Report ambiguous cases instead of guessing at intent. Do not “clean up” a warning just because it looks verbose.
