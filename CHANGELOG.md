# Changelog

## Unreleased

- Added an offline OTLP trace-to-profile importer with strict attribute allowlisting and output redaction.
- Added token-based PHP structure checks, PostgreSQL/MySQL EXPLAIN JSON review, schema metadata checks, Markdown output, and baseline regression gates.
- Expanded Laravel performance tests to cover telemetry privacy, plan parsing, schema validation, static-analysis false positives, and CI gating.
- Added an opt-in warning-only pre-commit hook that scans staged PHP blobs and safely preserves existing or user-modified hooks.

## 1.0.0 — 2026-09-30

- Created the Agent DevKit skill catalogue and a dependency-free installer for user and project scopes.
- Added newly authored guidance for application reviews, backend performance, production database planning, web diagnostics, and engineering workflows.
- Added a Laravel performance scanner for source-pattern candidates and sanitized aggregate profiles; it does not connect to databases or services.
- Added installer lifecycle tests and Windows/Ubuntu CI.
