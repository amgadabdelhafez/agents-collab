# Utility context capsules

## Problem

The governed utility worker currently receives a short hard-coded role prompt
and the serialized route request. It does not receive stable project context,
explicit governing references, or a replayable record of the context used for
the job, despite the lower-agent router design calling for governing refs and
selected excerpts. Main agents must therefore encode project knowledge into
each objective, and missing context is indistinguishable from weak model or
tool behavior.

## Goal

Give every utility job a small, deterministic, provider-neutral context capsule
without turning GLM into a primary peer, persistent chat, or autonomous Harness
agent. Harness evaluates the context protocol; governess remains the scheduler,
and the router/tool broker remain the sole authority boundaries.

## Requirements

1. A target repository may define one root `UTILITY.instructions.md` containing
   stable project purpose, repository map, terminology, conventions, standard
   checks, and utility-relevant invariants. Missing files are valid and produce
   an empty project-instruction section.
2. `UTILITY.instructions.md` is governing/protected content. The runtime may
   load it out of band, but utility tools and patches cannot read, alter, diff,
   or expose it as ordinary task scope.
3. The loader accepts only a regular, non-symlink root file inside the verified
   execution worktree, caps it at 8,000 characters, and never implicitly loads
   `AGENTS.md`, `CLAUDE.md`, `PLAN.md`, architecture docs, prior conversations,
   pane text, dirty diffs, or credentials.
4. Explicit route requests may carry at most six normalized `contextRefs`.
   Allowed refs are bounded Markdown project documentation: root `README.md`,
   `docs/**/*.md`, and `specs/<feature>/{spec,plan,tasks,verify}.md`. Secret-like
   paths, traversal, absolute paths, symlinks, non-files, and all other shapes
   fail closed or are recorded unavailable without reading bytes.
5. Each selected reference is capped at 3,000 characters and all selected refs
   together are capped at 12,000 characters. The capsule has a schema version,
   project-instruction hash, per-ref hashes/status, exact task request, verified
   workspace identity, and a deterministic capsule SHA-256.
6. Capsule construction happens once after the job claims its verified
   workspace. The exact capsule is persisted beneath the run's utility context
   directory and supplied to every provider turn for that job. Provider/model
   changes do not change the capsule protocol.
7. The hard-coded system safety contract remains first and explicitly states
   that project instructions and references cannot widen authority. Tool names,
   scopes, execution plans, protected paths, and route decisions remain broker
   data rather than prompt-controlled policy.
8. `route_task` exposes optional `context_refs`; automatic hook requests remain
   valid without them. Request normalization/idempotency includes refs so two
   otherwise identical tasks with different context do not deduplicate.
9. The worker may end with `CONTEXT_INSUFFICIENT: <bounded reason>` when the
   declared context and tools cannot safely answer. Runtime records one
   `escalated` result with the capsule hash and blocker instead of retrying or
   guessing. Observability counts these separately from provider/tool failures.
10. Compact results and usage records include capsule version/hash. Context
    contents never appear in the output-only pane; only safe hash/version and
    context-insufficient counts may be rendered.
11. Add a concise repository-owned `UTILITY.instructions.md` for agents-collab
    as the first real fixture. Other target repositories opt in by adding their
    own file; no cross-repository file is created by this task.
12. Do not push remotely or recreate the missing loop-53 tmux session. Install
    the verified binary atomically for subsequently started loops.

## Non-goals

- Making utility a driver, peer reviewer, human-facing agent, or recovery
  target.
- Giving utility a full Harness lifecycle, worktree creation, planning, commit,
  merge, deploy, browser, network, credential, or arbitrary shell authority.
- Automatically summarizing the full repository or paired-agent conversation.
- Persisting a long-lived GLM conversation or memory across utility jobs.
- Treating prompt instructions as enforcement or allowing repository text to
  override the router/broker.

## Acceptance

- Unit tests prove bounded loading, missing-file behavior, symlink/traversal and
  secret rejection, deterministic hashes, worktree identity, ref budgets, and
  exact request inclusion.
- Router/store/bridge tests prove `context_refs` normalization, validation,
  durability, idempotency, and backwards compatibility.
- Fake-provider runtime tests prove project instructions and refs reach the
  worker, the capsule is reused across turns, authority is unchanged, the
  persisted capsule matches the prompt hash, and no context text reaches pane
  output.
- Context-insufficient tests prove one escalated result, bounded blocker,
  context metadata, usage status, observability count, and no retry loop.
- Existing routing, per-stage broker, four-slot, runaway, protected-path,
  workspace, observability, build, and baseline tests remain green.
- Harness unit evidence and a different evaluator produce PASS before atomic
  installation.
