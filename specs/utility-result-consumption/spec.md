# Spec: Utility Result Consumption

## Problem

`get_task_result` returns the durable result of a Nanny or Au Pair task, but it
does not resolve the matching utility handover already queued for the caller.
Run 139 demonstrated the split state: Claude read two completed results through
`get_task_result`, while both handovers remained pending in `bridge.jsonl` and
the reconciliation pane continued to report them as awaiting delivery. A later
`receive_messages` call can therefore redeliver results the agent already read.

## Requirements

1. A successful `get_task_result` call by an in-loop agent must mark that
   caller's matching pending utility handover delivered.
2. Matching must require utility source, handover type, and the exact task ID.
3. The call must preserve unrelated peer messages, other task results, and
   results addressed to another agent.
4. An active bridge delivery claim must preserve the handover for the claimant.
5. A supervisor result lookup must not consume the requester agent's handover.
6. The returned task result payload must remain unchanged.
7. A non-supervisor lookup must be bound to the durable job requester, and a
   requester handover preserved through a supervisor lookup must remain
   drainable by that requester.

## Non-goals

- Changing utility execution, routing, or result production.
- Changing `receive_messages` delivery semantics.
- Rewriting historical run journals.
