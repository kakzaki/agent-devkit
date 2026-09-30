---
name: code-architecture-drawer
description: Explain a repository's structure, dependency direction, runtime boundaries, and architectural risks from available source evidence. Use for onboarding, system maps, or architecture review.
---

# Repository Structure Map

Build a concise model of the code that exists. Do not infer runtime behavior from a folder name alone, and do not change application files.

## Explore

1. Identify entry points, deployable units, manifests, configuration, and main test boundaries.
2. Trace representative imports and calls between modules. Distinguish observed dependencies from inferred runtime communication.
3. Locate external systems, persistence, queues, and API boundaries from configuration or call sites; redact secret values.
4. Note cycles, overly broad modules, duplicate ownership, and dependency direction only when concrete examples support the claim.
5. Ask for deployment diagrams or operational context when source code cannot establish runtime topology.

## Output

Provide a short system overview, a Mermaid diagram only when the relationships are sufficiently supported, a component table, and a list of risks/questions with file evidence and confidence. Mark missing context explicitly. Do not claim standards compliance from a source scan alone, and do not produce measurements the repository does not expose.
