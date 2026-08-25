# Web UI T-01: canonical side-effect-free read model

## Outcome

A typed, deterministic service materializes canonical fleet, run, and timeline
projections from durable Loop evidence without starting processes, repairing
state, acknowledging records, sending messages, or otherwise acquiring runtime
authority.

This slice implements only T-01 from `specs/webui-control-plane/tasks.md` and
builds on completed T-00 commit `2709faa802d4eff782b5ba21a37aec35af790663`.

## Requirements

- Define a capability-typed read-only dependency interface and keep pure source
  readers separate from migration, index rebuild, expiry, acknowledgement,
  append, send, spawn, kill, restart, and default-tmux operations.
- Materialize manifest, transcript, normalized hooks, Governess state/control,
  bridge, utility observability, usage, and bounded adapter diagnostics.
- Key a run only by repository ID plus run ID. Never promote process, pane,
  socket, transcript, or heuristic rows into canonical runs.
- Require manifest repository/run identity to match its selected run-root path;
  mismatches are corrupt and never canonical.
- Emit source revision, freshness, quality/confidence, and explicit conflicts.
- Retry a projection once if source revisions change while reading; a second
  change returns a bounded unstable/conflict result rather than mixing epochs.
- Separate persisted requirements from observed state and implement a versioned
  aggregate status matrix. Unknown evidence stays unknown and cannot become
  healthy by default.
- Define source-specific freshness thresholds and test below, equal, and above
  every boundary with a fake clock.
- Build deterministic, escaped, redacted timeline rows with stable ordering,
  bounded pages, and opaque evidence references protected by containment checks.
- Use producer-derived fixtures, including T-00 legacy/identity/config variants.
- Do not expose raw prompts, proof, credentials, tokens, URLs, socket paths,
  workspace paths, provider payloads, hidden environment, or unbounded terminal
  output in Web-facing DTOs.
- Do not change runtime producers, lifecycle admission, maintenance behavior,
  launch/control authority, or the existing Web server/UI in this slice.

## Allowed implementation paths

- `loop-fork/src/loop/control-surface/types.ts`
- `loop-fork/src/loop/control-surface/sources.ts`
- `loop-fork/src/loop/control-surface/projection.ts`
- `loop-fork/src/loop/control-surface/timeline.ts`
- `loop-fork/src/loop/control-surface/redaction.ts`
- Corresponding new focused tests under `loop-fork/tests/loop/control-surface/`
- Producer-derived fixtures under `loop-fork/tests/fixtures/control-surface/`
- Task-owned Harness evidence and this spec bundle

Any existing product-source edit or additional path requires an explicit scope
update before editing.

## Non-goals

- T-02 HTTP, authentication, SSE, CLI dispatch, or embedded assets.
- Browser components, mutation endpoints, attach commands, or preferences.
- Repairing malformed evidence or updating producer schemas.
- Replacing existing dashboard or Harvto live-data code.
