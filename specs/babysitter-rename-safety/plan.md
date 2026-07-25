# Plan: Babysitter Rename Safety

1. Add an explicit `agentRenameEnabled` babysitter config value sourced from
   `LOOP_BABYSIT_AGENT_RENAME`, defaulting to false.
2. Gate the existing rename sender on that value while preserving its dry-run,
   deduplication, and busy-state checks for opt-in users.
3. Pass the opt-in environment variable through tmux startup and document it.
4. Add regression tests for default-off and explicit-opt-in behavior.
5. Build, verify, and respawn only the live babysitter pane.
