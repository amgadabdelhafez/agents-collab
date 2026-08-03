# Spec: Aggressive Au Pair Routing

## Problem

Harvto loop 118 submitted nine helper packets. Four exact packets ran Direct,
two small inspections ran on Nanny, and all three bounded Git-object audits were
returned to Codex because `kind: "review"` is intercepted before utility tier
classification. No edit packet was submitted, so Au Pair received zero work
despite a healthy GLM provider.

The prompt says Au Pair handles focused verification and cross-file judgment,
but the router keeps every review with a main agent. The Nanny classifier also
admits reasoning-backed commands and up to four read scopes, which is wider
than its documented small-inspection role.

## Goal

Move materially more bounded reasoning, verification, audit, and small patch
proposal work to Au Pair/GLM while keeping peer verdicts, authority, release,
architecture, protected scope, and final acceptance with Claude or Codex.

## Required behavior

1. `route_task` accepts an explicit review mode:
   - `utility-audit` requests a non-authoritative evidence audit from Au Pair;
   - omitted or `peer-verdict` preserves the existing main-agent peer/reviewer
     route.
2. A utility audit is eligible only when it is low risk, authority-free,
   read-only, has one through six exact read scopes, includes `inspect`, and
   passes the existing bounded execution-metadata, protected-path, workspace,
   epoch, health, capability, and policy gates.
3. Utility audits always classify to Au Pair. Exact deterministic reads and
   checks remain Direct for ordinary inspect/command packets, but a requested
   evidence audit is not silently reduced to raw tool output.
4. Authority-bearing, medium/high/unknown-risk, protected, malformed,
   write-bearing, or unmarked reviews never reach Au Pair.
5. Nanny handles only bounded inspections. A profiled Nanny inspection has at
   most two read scopes and a read plan has at most two stages. Reasoning-backed
   command packets, larger inspections, and focused synthesis go to Au Pair
   unless they are fully deterministic Direct work.
6. Main-agent guidance requires agents to use `review_mode=utility-audit` for
   bounded evidence audits and `kind=edit` before authoring meaningful decided
   one- or two-file code blocks. The guidance distinguishes utility findings
   from peer verdicts and release gates.
7. Au Pair remains proposal/evidence only. A main agent reviews every result,
   applies patches through the guarded tool, and owns final verification.

## Safety boundary

- Utility audits cannot write, apply, commit, push, merge, deploy, install,
  access credentials, make product decisions, or approve a release.
- `review_mode` is valid only for `kind: "review"`; all other combinations
  fail closed.
- Peer verdicts and reviews without an explicit utility-audit marker preserve
  current behavior.
- Provider choice remains Governess-owned. Agents cannot request GLM directly.
- Existing exact edit scopes, preimage validation, patch size limits, health
  gates, concurrency, and broker-only tool access remain unchanged.

## Non-goals

- Replacing independent Claude/Codex review for exact-SHA or release gates.
- Automatically applying Au Pair output.
- Giving GLM shell access or persistent chat context.
- Weakening protected-path, authority, credential, or workspace boundaries.
- Mutating the currently healthy live loop during implementation.
