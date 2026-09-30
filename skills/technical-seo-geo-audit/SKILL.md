---
name: technical-seo-geo-audit
description: Assess how pages expose useful, crawlable, understandable information to search engines and answer systems. Use for technical discoverability, metadata, rendering, structured data, or content access questions.
---

# Discoverability Review

Review only the URLs or files the user authorizes. Separate search-engine fundamentals from optional machine-readable conveniences. Do not promise ranking, citations, or crawler behavior.

## Review dimensions

- Confirm canonical URL behavior, status codes, redirects, robots directives, sitemap consistency, and internal-link reachability.
- Compare supplied raw HTML and rendered output when both exist. Identify content that depends on client execution without declaring it invisible unless verified.
- Check page title, description, headings, language, canonical link, social metadata, and structured data for consistency with visible content.
- Assess semantic structure, accessible names, useful page text, duplicate/near-empty pages, and information that is hidden behind interaction.
- For answer-system access, inspect the supplied crawler policy and content format; do not assume that a special text file or crawler allowlist is required by every service.

## Safety and evidence

- Prefer local files, saved responses, or a small explicitly permitted sample. Do not crawl entire sites or bypass access controls.
- Redact query-string credentials, customer identifiers, and private page content.
- Label an item as observed only when the relevant response or rendered state was inspected. Otherwise mark it as a hypothesis or not checked.
- Do not change robots rules, canonical tags, redirects, or structured data without explicit implementation approval and a regression plan.

## Report

Summarize scope, evidence source, verified problems, likely impact, recommended edits, and verification steps. Prioritize broken access/indexing and misleading metadata above optional enhancements. Include limitations and avoid fabricated scores.
