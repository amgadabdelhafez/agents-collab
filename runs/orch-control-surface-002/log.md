# ORCH-CONTROL-SURFACE-002 log

- Bound from reviewed task-DAG closure
  `10e69e91514e772920da8d4e530214d1b45950dc`.
- Added `TaskGraphRuntime`, a narrow canonical runtime wrapper over the existing
  `WorkflowPort` for graph creation, status, readiness, governed signals, and
  cancellation.
- Added an authenticated Fetch-compatible orchestration HTTP surface for
  SupervisorMessage operations, durable thread/Attention/knowledge projections,
  and task-graph lifecycle operations.
- The authenticated request identity is authoritative for supervisor, principal,
  and worker ownership. Body fields cannot impersonate another worker.
- Invalid graph definitions fail before workflow creation. Responses are
  `Cache-Control: no-store`, request bodies are bounded, and errors expose stable
  codes rather than internal details.
- Focused gates: task-graph runtime 1 passed / 0 failed; orchestration HTTP 3
  passed / 0 failed.
- Repository gates: `bun run check` PASS; `bun run build` PASS;
  `git diff --check` PASS.
- Complete gate: `bun run test:ci` PASS with an empty named failure set.
