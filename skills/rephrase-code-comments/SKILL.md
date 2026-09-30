---
name: rephrase-code-comments
description: Improve the clarity of comments, docstrings, and developer-facing notes without changing their technical meaning, scope, or language.
---

# Clear Comment Writing

Rewrite only the text the user identifies. Preserve documented behavior, names, numbers, examples, caveats, and language-specific syntax. Do not translate unless asked.

## Writing rules

- Put the main fact or reason first. Prefer familiar words and direct sentences.
- Keep a sentence short when that does not remove a necessary condition or exception.
- Preserve the distinction between what code guarantees and what it merely attempts.
- Do not convert uncertainty into certainty, rationale into a command, or an example into a promise.
- Follow the language's doc-comment grammar and keep tags, parameter names, links, and code spans valid.
- Leave comments that contradict code untouched until the behavior is understood; report the mismatch instead.

## Safe editing

Preview the target files and the intended meaning before bulk edits. After editing, compare the diff and confirm that executable tokens and surrounding code are unchanged. Ask before changing comments that communicate security, legal, privacy, or operational policy.
