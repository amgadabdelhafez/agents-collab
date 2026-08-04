# Project World Model Phase 0

## Problem

Loop can retrieve documents and memories and can replay authoritative journals,
but it cannot yet construct a bounded answer to how code, requirements, tests,
runs, decisions, evidence, and current temporal state relate. Agents therefore
reconstruct a partial project model independently on each decision.

## Outcome

Provide a local, provenance-first temporal project context graph that compiles
decision-specific context while remaining a disposable projection of Git,
manifests, and append-only journals.

## Authority boundary

- Git blobs, exact commits, manifests, and append-only journals remain the
  operational sources of truth.
- The world model cannot authorize routing, release, deployment, permissions,
  lifecycle changes, delivery, or mutation.
- Deterministically observed statements may be presented as observations.
- Model- or user-supplied statements enter as candidates or assertions and are
  never silently promoted to observations.
- A missing, stale, or corrupt world-model database cannot be interpreted as a
  healthy system or as permission to proceed.

## Core statement

Every relationship is a statement with:

- stable statement id;
- subject, predicate, and object ids;
- exact evidence source and SHA-256;
- source kind and extraction method;
- repository and commit scope when applicable;
- observed time and optional validity interval;
- authority class, confidence, and status;
- optional superseded-statement id.

Statuses are `observed`, `asserted`, `inferred`, `disputed`, and `superseded`.
Only deterministic producers may create `observed` statements.

## Core ontology

Initial entity types are Repository, Worktree, Branch, Commit, Component, File,
Symbol, Dependency, Spec, Requirement, Constraint, Test, Task, Job,
RouteDecision, Lease, Run, Session, AgentRole, Process, Pane, Port, Decision,
Claim, Evidence, Finding, Artifact, Evaluation, Metric, ReleaseCandidate, and
Deployment.

Initial predicates are `contains`, `defines`, `imports`, `calls`, `depends_on`,
`implements`, `verifies`, `violates`, `supersedes`, `produced_by`, `observed_in`,
`derived_from`, `bound_to_sha`, `applies_to_scope`, `authorized_by`,
`assigned_to`, `routed_to`, `blocked_by`, `supports`, `contradicts`,
`reviewed_by`, `running_as`, and `deployed_as`.

The ontology and taxonomies are versioned data. Unknown types and predicates
fail validation instead of being silently admitted.

## Competency questions

Phase 0 must support bounded evidence-backed answers to:

1. What repository and exact commit does this fact apply to?
2. Which files and components are structurally connected to this file?
3. Which specs and tests are in the bounded neighborhood of a component?
4. What current statements exist about this entity?
5. What was believed at a specified time?
6. Which current statements contradict one another?
7. Which statement superseded an older statement and why?
8. What exact source produced each returned statement?
9. Which prior runs, findings, or decisions mention the affected entities?
10. Which constraints apply to this task or component?
11. Which review or evaluation is bound to a candidate commit?
12. Which release candidate or deployment contains a commit?
13. What evidence is observed versus asserted or inferred?
14. Is a context result incomplete because a depth or result bound was hit?
15. Can the same source state rebuild an identical logical graph?

## Context contract

A decision context is versioned and bounded by seed terms or entity ids,
maximum graph depth, maximum statements, and optional time. It returns:

- matched entities;
- current or time-valid statements;
- evidence pointers and hashes;
- applicable constraints;
- contradictions and supersession history;
- explicit truncation and unknown markers;
- a deterministic capsule SHA-256.

The capsule is data for agent reasoning. It is not a policy decision.

## Storage and locality

Phase 0 uses a local SQLite database through `bun:sqlite`. The database path is
explicit or derived beneath the local Loop data directory. It performs no
network requests and requires no background service.

## Non-goals

- Learned predictive dynamics.
- Automatic ontology evolution.
- Automatic application of LLM-extracted facts.
- Replacing Markdown, Pickbrain, Witchcraft, or Obsidian.
- Graph-server adoption before the Phase-0 bakeoff.
