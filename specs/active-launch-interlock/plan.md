# Plan: active paired-launch interlock

## Approach

Introduce a small workspace-binding/reservation module at the CLI boundary.
The module canonicalizes the target, serializes repository launch decisions,
and writes a durable claim manifest before task resolution. Existing tmux
startup then consumes that reserved run, while cleanup gains an explicit
created-session ownership bit.

## Sequence

1. Add `--workspace`, canonical Git binding resolution, and early workspace
   entry while preserving relative Markdown prompt paths.
2. Extend run manifests with immutable launch binding/claim fields and atomic
   write/atomic numeric run-directory reservation helpers.
3. Add repository-scoped reservation and conflict classification before
   `resolveTask`; preserve explicit resume semantics.
4. Thread the reservation into paired startup, persist source-charter SHA-256,
   and restrict tmux cleanup to sessions created by this invocation.
5. Add unit, concurrency, integration, and isolated compiled-smoke coverage.
6. Verify, commit, obtain independent exact-SHA review, and deploy only if every
   gate is green.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Workspace identity | Canonical root plus full symbolic branch ref | Cwd and charter hashes cannot identify an external worktree safely. |
| Coordination | Short repository-scoped exclusive lock plus durable claim manifest | Serializes scan/allocation while allowing distinct workspaces after the claim is durable. |
| Legacy active runs | Fail closed for fresh launch | Their intended target cannot be proven distinct. |
| Cleanup authority | Positive local `new-session` ownership only | Prevents a losing launcher from killing the winner. |
| Charter hash | Secondary persisted evidence | Useful for audit/dedupe, but never a substitute for workspace identity. |

## Risks

- A stale lock could block launch. Mitigation: lock metadata records owner pid;
  reclaim only after affirmative owner death.
- A terminal manifest may briefly retain a live tmux session. Mitigation: live
  or unknown topology remains blocking regardless of manifest state.
- Changing cwd can break relative prompt paths. Mitigation: absolutize an
  existing relative Markdown prompt before workspace entry.

## Not doing

No charter-prose parsing, broad run deletion, live-run restart, or changes to
agent behavior after a workspace has been admitted.
