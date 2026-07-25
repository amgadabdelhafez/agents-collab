# Plan: Babysitter Exit Control

1. Add a small exit-control state machine and raw TTY key queue.
2. Persist graceful-handover notification and launch state in babysitter state.
3. Add injected lifecycle dependencies for pane commands, manifest stop,
   replacement launch, and tmux teardown.
4. Fold menu/progress banners into the existing top status row without growing
   the 20-row board.
5. Test key mapping, idle gating, exit detection, successful launch ordering,
   failure preservation, and teardown.
6. Build, independently evaluate, deploy only the babysitter pane, and live-test
   `x` followed by cancel; do not exercise destructive `e` or `h` on live work.
