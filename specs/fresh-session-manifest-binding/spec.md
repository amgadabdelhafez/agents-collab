# Fresh tmux-session manifest binding

## Problem

`startPairedSession` computes the deterministic tmux session name immediately,
but a fresh launch does not persist that name until after persistent-agent
bootstrap, launch-charter generation, tmux pane creation, prompt delivery, and
pane discovery. During that window the run manifest can claim an active paired
run while omitting `tmuxSession`.

This was observed during the run-100 recovery. It weakens lifecycle recovery,
Governess discovery, and conservative garbage collection because they cannot
associate the active run with the tmux workspace that is being created. The
session identity is not speculative: it is already deterministic and reserved
by the launch path before any asynchronous bootstrap begins.

## Requirements

1. On a fresh paired launch, persist the deterministic `tmuxSession`, paired
   mode, launcher PID, working directory, primary agent, and left/right agent
   identities immediately after the existing-session check and before hooks,
   persistent-agent bootstrap, proxy startup, charter writes, or tmux creation.
2. The early manifest update must preserve all existing run fields and use the
   normal manifest timestamp/update path.
3. An existing live tmux session must keep the current reattach behavior and
   must not be treated as a fresh launch.
4. Successful startup must still replace the early identity-only record with
   actual stable pane targets and persistent transport identities.
5. Any later startup failure must retain `tmuxSession` while transitioning the
   manifest to `failed`; owned persistent resources and a partially created
   session must continue through the existing bounded cleanup path.
6. The change must not add tmux-server/client process cleanup. On macOS the
   long-lived process whose command line retains `tmux new-session` can be the
   tmux server itself; it must not be classified as a leaked launcher client.
7. No live run, pane, process, or manifest may be mutated during verification.

## Scope

- Paired tmux launch manifest ordering in `loop-fork/src/loop/tmux.ts`.
- Focused unit tests that inspect manifest state at the first asynchronous
  startup boundary and after success/failure.
- No Governess render-loop changes; freshness/self-exit is a separate defect.
- No runtime deployment until exact-SHA independent review concurs.
