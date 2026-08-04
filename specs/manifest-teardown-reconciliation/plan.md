# Plan: Manifest Teardown Reconciliation

1. Add a guarded producer that terminalizes only an active manifest whose
   unchanged tmux binding is affirmatively dead.
2. Call it after confirmed lifetime-poll death and on signal shutdown.
3. Cover dead, live, unknown, concurrently rebound, and already-terminal
   manifests with producer-backed tests.
4. Run focused proxy tests, the required broader checks, and request exact-SHA
   supervisor review.

