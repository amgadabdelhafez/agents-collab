# Utility Worktree Adoption Task Log

- 2026-07-26: Diagnosed loop 47 from live journals. Seven early Claude
  large-read/source-slice jobs reached utility (10 model calls, 5 tool calls,
  4 completed, 3 failed). Three later Codex inspections fell back with
  `protected-scope` because their absolute scopes were under
  `/private/tmp/harvto-loop47-base` while the run root was
  `/Users/amgad/harvto`. Two later reviews correctly routed to the peer.
- 2026-07-26: Scoped the fix to Git-verified same-repository linked worktrees;
  arbitrary temporary directories remain denied.
# Utility worktree adoption task log

## 2026-07-26 implementation

- Reproduced the boundary mismatch from loop 47: run root
  `/Users/amgad/harvto`, active scopes under
  `/private/tmp/harvto-loop47-base`.
- Added a runtime workspace resolver that canonicalizes absolute scopes and
  compares Git common directories before adopting a linked worktree.
- Kept the pure router unchanged: it receives only root-relative scopes after
  verification, so protected-path, authority, conflict, capability, and budget
  gates still apply.
- Journaled the verified root and relative scopes on the route decision.
- Reverified the journaled root before detached spawn, worker tool brokering,
  and guarded patch apply.

## Verification

- Focused router/runtime/tools/bridge set: 73 pass, 0 fail.
- Broad utility/bridge/governess/tmux set: 351 pass, 0 fail.
- Full suite: 778 pass, 4 known Codex-model/config baseline failures; no new
  failures.
- `bun run build`: pass.
- `scripts/verify.sh`: exits 0; repository script still contains placeholder
  lint/typecheck/test blocks.
- `git diff --check`: pass.

## Regression coverage

- Linked worktree resolves to root-relative scope.
- Worker tool result contains the linked checkout content, not base content.
- Guarded apply modifies only the linked checkout.
- Unrelated repository, base plus worktree, two worktrees, and symlink escape
  all fail closed.
- Runtime persists a safe mismatch detail and does not spawn a worker.

## Independent evaluation follow-up

- Initial evaluation found workspace-blind write claims and a copied-`.git`
  worktree-registration spoof. Both were fixed before integration.
- Claims now compare normalized scopes only within the same workspace root.
- Initial adoption and every revalidation require the canonical root to appear
  exactly in `git worktree list --porcelain`.
- Independent evaluation: PASS (`eval.json`), 87 focused tests.

## Live loop 47 acceptance

- Integrated locally as canonical merge `b2b8b6c` and rebuilt the compiled
  `loop` binary.
- Refreshed only governess pane `%3`; Claude `%0` PID `56784` and Codex `%1`
  PID `56786` were unchanged.
- Submitted bounded inspect job `00861be8-202e-4fcf-9705-db2e27366d3b`
  against the active `/private/tmp/harvto-loop47-base` worktree.
- Durable decision: `utility/utility-eligible`, workspace root
  `/private/tmp/harvto-loop47-base`, relative read scope
  `03-Development/tools/mesh-gen/fixtures/local-reference.json`.
- Worker completed in 4.9 seconds using `read_file`, 2 model calls, 1 tool
  call, 2,090 tokens, and about $0.0008. Result identified
  `local-wrap-fixture`; no base-checkout read occurred.
