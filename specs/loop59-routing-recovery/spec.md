# Loop-59 routing recovery

## Problem

Loop-59 considered 253 routing candidates but sent only five to helpers. After
the last helper completion, nine explicit packets produced zero helper jobs.
Two current low-risk document audits are utility-eligible when their narrative
`context_refs` are removed, but the live contract neither documents nor
validates that `context_refs` accepts repository-relative Markdown paths only.
The bridge also cannot express the structured execution metadata supported by
the deterministic router, leaving `structuredPlans` at zero.

Au Pair accepted three jobs but failed all three: two stopped after three
consecutive broker rejections and one consumed 32 tool calls without reaching a
result. More routing is not useful until rejected-call feedback enables bounded
adaptation and repeated exploration is curtailed.

## Required behavior

1. `route_task` documents and immediately validates the exact `context_refs`
   grammar. Narrative context belongs in the objective or acceptance criteria;
   invalid references do not create doomed journal jobs.
2. `route_task` accepts the router's existing structured execution fields,
   including bounded read plans, exact reads, searches, Git inspection, and
   focused checks. Bridge parsing cannot widen any router or broker boundary.
3. Main-agent guidance explains the context-reference contract and asks for
   independently answerable small inspections to be decomposed into Nanny-sized
   packets without falsifying risk or splitting cross-file judgment.
4. Au Pair receives concise broker rejection feedback sufficient to correct a
   malformed call, while the existing rejection breaker, tool ceiling, scope,
   output, and authority limits remain fail-closed.
5. Live deployment reloads bridge MCP and supervisory/helper processes only.
   Claude and Codex agent processes must retain their PIDs and active context.
6. A live low-risk canary using the repaired contract must route, execute, and
   return to its named requester. No repository source mutation is permitted by
   the canary.

## Non-goals

- No broader protected-path, authority, risk, command, network, credential, or
  automatic patch-application permission.
- No automatic risk downgrades.
- No restart of Claude or Codex.
- No push, merge to main, or Harvto product-code change.

