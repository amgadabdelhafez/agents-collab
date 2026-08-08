# Governess handover launch order

## Problem

Governess validates both agent handoff bundles and waits for both agents to
exit, then invokes the successor launcher while the predecessor run manifest
still advertises a live tmux session for the same workspace. Launch reservation
therefore rejects the otherwise valid successor with a self-conflict.

Runs 14-32 and 34-37 reproduce the same sequence against v1.0.35: both bundles
exist, `exitControl.mode` becomes `launch-error`, and the error says the same run
still owns its workspace.

## Requirements

1. A validated handoff must release the predecessor's workspace ownership
   before invoking the successor launcher.
2. Release must persist the predecessor as terminal and remove only its active
   tmux session target; historical workspace and socket metadata remain intact.
3. If a configured predecessor manifest cannot be read or persisted, launch
   must fail closed before invoking the successor process.
4. Validated handoff bundles and manifest remain byte-identical.
5. Dirty worktree bytes, unrelated run manifests, tmux sockets, lanes, and
   processes remain untouched.
6. Add at most one direct regression for the reservation-order failure.

## Acceptance

- The predecessor does not satisfy the production
  `manifestCanStillOwnWorkspace` predicate when successor spawn begins.
- Existing handoff retry, acceptance, liveness, and teardown tests still pass.
- Focused test, type, build, and check smokes pass.
- Claude performs a zero-write review of the concrete diff.
- `runs/d001-governess-handover/eval.json` records passing evidence before one
  scoped commit.

## Non-goals

- No reservation protocol redesign or atomic cross-process transfer.
- No successor-loop context expansion, dependency change, install, push,
  merge, release, or unrelated backlog work.
