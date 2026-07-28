# Caveman integration

## Goal

Integrate the upstream `JuliusBrussee/caveman` output-compression rules into
loop-launched main agents and bounded helpers without changing route authority,
tool permissions, evidence semantics, or global agent configuration.

## Upstream

- Repository: `https://github.com/JuliusBrussee/caveman`
- Pin: `0d95a81d35a9f2d123a5e9430d1cfc43d55f1bb0`
- Observed release tag at the pin: `v1.9.1`
- License: MIT

The dependency must remain exact and reproducible. The compiled loop binary may
embed the upstream skill text, but installation and loop launch must not fetch or
execute an unpinned remote script.

## Required behavior

1. Paired loop prompts use upstream Caveman output rules by default.
2. Main Claude/Codex prose defaults to `lite`; helper final summaries default to
   `full`.
3. Operators can choose `off`, `lite`, `full`, or `ultra` with a CLI option or
   environment variable. Explicit CLI input wins over environment defaults.
4. Compression applies to explanatory prose only. Code, commands, paths, URLs,
   JSON, errors, SHAs, resolver output, bridge identifiers, verdicts, citations,
   and evidence must remain exact.
5. Security warnings, destructive confirmations, ordered procedures, and any
   ambiguous compressed statement use normal clear prose, matching Caveman's
   upstream Auto-Clarity boundary.
6. The selected main/helper modes are persisted in the run manifest and visible
   in Governess so a run's communication contract is auditable.
7. New modes apply at new session launch. Resuming an existing paired run retains
   its persisted modes unless the operator explicitly overrides them.

## Explicit non-goals

- Do not wrap the loop bridge with pre-1.0 `caveman-shrink`; bridge tool
  descriptions contain safety and permission constraints.
- Do not install Cavecrew roles; Nanny/Au Pair already own those bounded roles
  under Governess policy.
- Do not run Caveman's global installer or mutate `~/.claude`, `~/.codex`, or
  global MCP registration.
- Do not claim the upstream 65% output reduction for loop workloads without an
  A/B run. Upstream itself warns that the skill can be net-negative on terse
  workloads.

## Safety invariants

- Governess remains the sole route/claim authority.
- Worker broker scopes and tool schemas are unchanged.
- Compression never changes request bodies, tool calls, tool results, or durable
  job evidence.
- `off` produces prompts equivalent to the pre-integration behavior.

