---
name: web-perf-audit
description: Diagnose a slow website or endpoint using supplied field data, browser measurements, traces, or source code. Recommend bounded experiments; do not invent metrics or stress production.
---

# Web Performance Diagnosis

Find the slow user journey and identify its largest evidenced costs. This is an analysis workflow: do not deploy changes, add telemetry, or run a load test unless the user separately authorizes that work and the target is safe.

## Scope and measurement

1. Ask which page, user action, device/network class, environment, and comparison period matter. Separate initial navigation from client-side transitions.
2. Inventory available evidence: real-user percentiles and sample window, browser trace, navigation/resource timings, server spans, bundle report, and relevant code. Record source, timestamp, population, and limitations.
3. If only code is available, label findings as hypotheses. Do not present local build output as user-facing latency.
4. Compare relevant user-visible milestones (content readiness, interaction response, layout stability) and attribute time to browser work, network, server, data store, and third parties where evidence permits.
5. Rank issues by user impact and confidence. Propose one small experiment at a time with a measurable success and rollback condition.

## Areas to inspect

- Critical rendering path, blocking resources, hydration/JavaScript work, route chunk size, and duplicate client requests.
- Image dimensions and delivery, font loading/fallback, third-party scripts, request priority, caching headers, redirects, and connection reuse.
- API timing and response size, repeated calls, server rendering waits, data dependencies, and cache freshness.
- On mobile/slow networks, CPU contention, long tasks, input delay, layout movement, and memory growth.
- Field-vs-lab disagreement: explain population, device, geography, sampling, cache warmth, and test conditions instead of averaging incomparable data.

## Guardrails

- Never fabricate a percentile, Lighthouse score, bundle size, or regression. Mark unavailable measurements **not measured**.
- Do not create production load, crawl aggressively, or send many repeated requests to a live host. Prefer staging, saved traces, provider field data, or a small approved sample.
- Do not collect personal data or expose API keys. Redact URLs containing tokens and customer identifiers.
- Do not add caching until cacheability, tenant/user isolation, freshness, and invalidation are understood.
- Separate measurements from causal hypotheses. A correlation is not proof that one change caused an improvement.

## Deliverable

Give an executive summary and a short table of findings with metric/evidence, likely cause, user impact, confidence, recommended experiment, and how to verify or roll back. List commands or measurements actually run. Close with missing evidence and work that should be done in staging.
