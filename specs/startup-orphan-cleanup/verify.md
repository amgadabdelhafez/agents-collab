# Verification

1. A paired tmux construction error calls persistent-session close exactly
   once and exits nonzero through the caller.
2. An abandoned active fixture with dead launcher, no tmux session, exact
   bridge command ownership, and exact app-server listener ownership signals
   only those PIDs and changes the manifest to `failed`.
3. Live tmux, live launcher, unknown tmux state, another repository, malformed
   manifest, bridge-command mismatch, app-server-command mismatch, and
   listener mismatch are preserved.
4. `--version` and `--help` still bypass all startup maintenance.
5. `scripts/verify.sh startup-orphan-cleanup startup-orphan-cleanup` passes
   with an empty baseline list.
6. `runs/startup-orphan-cleanup/eval.json` records the verification and exact
   independent review gate.
