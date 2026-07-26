# Plan: Lower-Agent Delegation Adoption

1. Add a provider-neutral, pure classifier that turns only exact bounded tool
   intents into existing `UtilityRouteRequest` inputs and emits compact telemetry
   decisions for everything else.
2. Extend the per-run hook command so Claude `PreToolUse` can journal the event,
   auto-submit an eligible request, and return a documented denial decision in
   enforce mode. Preserve fail-open hook behavior on operational errors.
3. Observe Codex app-server `item/started` command/file notifications in the
   tmux proxy and record missed deterministic candidates without changing proxy
   forwarding or execution.
4. Record explicit bridge `route_task` adoption, strengthen route-first startup
   and MCP instructions, and expose compact adoption counters in the utility
   pane.
5. Add deterministic tests for classification, hook decisions, Codex proxy
   pass-through, bridge telemetry, prompts, and pane rendering.
6. Run focused and full verification, obtain independent evaluation, then
   integrate and atomically install only for future loops.
