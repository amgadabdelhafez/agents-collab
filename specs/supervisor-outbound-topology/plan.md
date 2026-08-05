# Plan

1. Generalize the durable bridge target type to include `supervisor` while
   retaining the narrower pane-agent type for runtime delivery.
2. Admit `supervisor` explicitly in MCP validation and schema; keep manifest
   topology checks for pane-agent targets.
3. Allow supervisor MCP sessions to drain the supervisor inbox.
4. Add producer-shaped regressions for agent-to-supervisor enqueue/drain,
   status accounting, schema exposure, and absent-Gemini rejection.
5. Run focused tests and the governed verifier, record eval evidence, commit,
   and request exact-SHA supervisor review. Stop before merge or deployment.
