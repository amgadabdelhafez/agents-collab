# Verification

1. Before `startPersistentAgentSession` executes on a fresh paired launch, the
   durable manifest already contains the deterministic `tmuxSession`, paired
   mode, launcher PID, cwd, primary agent, and left/right agent identities.
2. A non-persistent agent pairing is bound before launch-charter generation and
   tmux creation as well.
3. A successful launch records stable pane IDs without losing early identity
   fields.
4. A failure after early binding records `state: failed` and `status: failed`
   while retaining the deterministic `tmuxSession`.
5. Reattaching to an existing session preserves current behavior.
6. No test or source path attempts to identify or kill a tmux process from its
   retained `new-session` command line.
7. Focused `tmux.test.ts` and the lifecycle regression band pass.
8. `scripts/verify.sh fresh-session-manifest-binding
   fresh-session-manifest-binding` passes with an empty baseline list.
9. `runs/fresh-session-manifest-binding/eval.json` records verification and an
   exact-SHA independent review gate before deployment.
