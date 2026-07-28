# Loop 57 Au Pair Recovery

## Problem

Loop 57 shows Au Pair as failed after an inspection asked it to locate modules
outside the packet's declared read scope. Separately, non-utility route outcomes
from a Codex request are sent to the current Claude driver rather than back to
Codex, so the bridge violates requester ownership.

## Required behavior

1. Every terminal helper or fallback route outcome returns to the agent that
   submitted `route_task`.
2. Only an explicit peer-review route is delivered to the other full agent.
3. A missing repository-relative path reports bounded in-scope candidate paths
   when an unambiguous suffix/name match exists, so the model can adapt without
   broadening scope.
4. Several failed sibling tools in one Pi model round consume one rejection
   round and permit an adaptation turn.
5. Live verification must include a fresh Au Pair job requested by Codex, a
   successful result delivered to Codex, and unchanged Claude/Codex pane PIDs.
6. Bridge guidance must state that moved-path discovery requires a declared
   common-ancestor scope because workers never widen scope.
7. `list_files` may inspect one bounded descendant directory inside the
   declared read scope; it must still reject parents, siblings, symlinks, and
   protected paths.
8. Nanny and Au Pair remain pane-border titles only. Transcript lines identify
   the model family as `QWEN` or `GLM`; full model/version details remain in
   Governess.
9. Both helper pane bodies contain only their own request/tool/result stream;
   the Nanny pane does not replay the Governess project summary.
10. Each helper job ID appears once, and the pane favors the actual request
    objective and result summary over generic completion counters.

## Safety constraints

- Candidate paths are suggestions only; no path is silently substituted.
- Suggestions remain inside the declared read scope and verified worktree.
- Nanny and Au Pair permissions are not widened.
- Claude and Codex are not restarted during the hot-swap.
