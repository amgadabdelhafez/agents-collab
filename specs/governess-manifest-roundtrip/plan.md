# Plan

1. Capture regressions for typed manifest round trips, restored Governess
   topology followed by a false-dead bridge probe, Claude config GC, and the
   startup orphan reaper's missing-session behavior.
2. Stop the bridge worker from erasing durable topology or deregistering an
   active run's Claude bridge based on a single liveness miss.
3. Make Governess startup read-only with respect to the manifest and reject
   incomplete modern pane ownership instead of falling back positionally.
4. Require affirmative dead-session evidence before destructive startup GC of
   nonterminal runs; missing ownership must not itself prove abandonment.
5. Run focused and full verification, record independent evaluation evidence,
   commit, and request exact-SHA review without deploying or touching run 101.
