# loop57-runtime-fixes Research

## Research Question

Which existing loop-fork, Pi SDK, bridge-store, and tmux patterns can fix the
Loop 57 routing/runtime failures without adding another proxy or authority
layer?

## Candidates Reviewed

- `src/loop/utility-store.ts`: reuse deterministic event ids and stable JSON
  collision checks; preserve the first event envelope for idempotent retries.
- `src/loop/bridge-store.ts` and `src/loop/bridge.ts`: reuse predicate-based,
  delivery-claim-aware inbox consumption for utility-only result draining.
- `@earendil-works/pi-agent-core`: Pi groups sibling tool results into a model
  turn, so rejection accounting belongs at the model-round boundary.
- `src/loop/tmux.ts`: reuse stable pane ids and full-width split support for
  read-only bottom Recon viewers.
- Commit `f3d310e`: reuse summary completeness/retry patterns, augmented with a
  deterministic current-session objective anchor.

## Open-Source Patterns

- Count tool failure streaks by model turn when sibling calls share one response.
- Persist exact allowlisted intent structurally and execute it without model
  reconstruction.
- Make deterministic journal retries idempotent without weakening collisions.
- Keep observability as a read-only projection of authoritative stores.

## Reuse Decision

Adapt the integrated Pi SDK and existing router, journal, bridge, and tmux
modules. Add no proxy, queue, or permission layer.

## Sources

- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/tmux/tmux/wiki/Getting-Started
- `src/loop/utility-store.ts`
- `src/loop/bridge-store.ts`
- `src/loop/bridge.ts`
- `src/loop/utility-runtime.ts`
- `src/loop/tmux.ts`
- `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`
- `node_modules/@earendil-works/pi-coding-agent/examples/extensions/tic-tac-toe.ts`
- Git commit `f3d310e`
