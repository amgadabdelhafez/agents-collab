# Verification

1. Before `startPersistentAgentSession` executes on a fresh paired launch, the
   durable manifest already contains the deterministic `tmuxSession`, paired
   mode, launcher PID, cwd, primary agent, and left/right agent identities.
2. A non-persistent agent pairing is bound before launch-charter generation and
   tmux creation as well.
3. A fresh relaunch clears stale concrete pane targets, while a live-session
   reattach preserves its current targets.
4. A successful launch records stable pane IDs without losing early identity
   fields.
5. A failure after early binding records `state: failed` and `status: failed`
   while retaining the deterministic `tmuxSession`.
6. Reattaching to an existing session preserves current behavior.
7. No test or source path attempts to identify or kill a tmux process from its
   retained `new-session` command line.
8. Focused `tmux.test.ts` and the lifecycle regression band pass.
9. `scripts/verify.sh fresh-session-manifest-binding
   fresh-session-manifest-binding` passes with an empty baseline list.
10. `runs/fresh-session-manifest-binding/eval.json` records verification and an
   exact-SHA independent review gate before deployment.
