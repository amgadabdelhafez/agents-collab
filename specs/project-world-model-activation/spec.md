# Project World Model Loop Activation

## Problem

Phase 0 ships a provenance-first Project World Model behind explicit
`loop world` commands. Ordinary paired-loop startup neither materializes a
run-scoped model nor tells agents how to consume bounded context, so the
feature is available but unused.

## Outcome

Every new or resumed paired tmux loop prepares a run-scoped Project World
Model before handing off to tmux. The run manifest binds the exact repository
commit, database, bootstrap context, and hashes. Both agent charters explain
how to verify and query that context, and governed pane environments expose
the two artifact paths.

## Activation contract

- Activation is default-on for promptless and task-bound paired tmux launches.
- Materialization completes before tmux handoff. Failure cancels the reserved
  launch rather than starting a loop that falsely advertises World Model
  context.
- The database and bootstrap capsule live below the canonical run directory.
- The manifest records absolute artifact paths, exact Git commit, ontology
  version, deterministic capsule SHA-256, context-file SHA-256, entity and
  statement counts, seeds, and generation time.
- Bootstrap seeds are derived from tracked entity labels explicitly mentioned
  in the task. A deterministic set of repository entry documents and the
  repository entity is used when the task is absent or has no matches.
- Context is bounded to depth 2 and at most 120 statements.
- Both agent charters require hash verification before relying on the capsule
  and direct further retrieval through `loop world context`.
- Pane environments expose `LOOP_WORLD_MODEL_DB` and
  `LOOP_WORLD_MODEL_CONTEXT`.

## Authority boundary

The activation does not change the Phase-0 authority boundary:

- Git blobs, manifests, and append-only journals remain sources of truth.
- World Model artifacts are evidence indexes and reasoning inputs only.
- They cannot authorize routing, lifecycle transitions, review, release,
  deployment, permissions, delivery, or workspace mutation.
- Missing, invalid, stale, or hash-mismatched artifacts require agents to fail
  closed and consult the sources of truth.

## Current-loop semantics

Resuming a stored paired run prepares or refreshes its run-scoped projection
before handoff. A tmux session that is already live is not mutated or restarted;
it continues with the artifacts and charter it launched with. If no paired
session is live, there is nothing to backfill until the next launch or resume.

## Non-goals

- Giving the World Model routing or control-plane ownership.
- Injecting model-generated assertions as observed facts.
- Mutating a healthy live pane or composer.
- Replacing ordinary Git, manifest, journal, or spec inspection.
