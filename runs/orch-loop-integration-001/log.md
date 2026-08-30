# ORCH-LOOP-INTEGRATION-001 log

- Temporal SupervisorMessage delivery now resolves the exact active run and its
  manifest-declared primary driver. The workflow identity is bound into the
  durable bridge record; callers cannot choose a run directory, pane, socket,
  or agent target.
- SupervisorMessage work for Codex is pull-only. App-server acceptance remains
  pending and cannot claim or acknowledge the workflow. Only the exact
  `read via receive_messages` bridge resolution is accepted as consumption.
- The server-owned reconciler reads that durable consumption evidence and
  applies idempotent governed `claim` then `acknowledge` commands under the
  configured target-supervisor identity. Reconciliation failures make health
  unavailable instead of silently accepting work.
- Focused bridge suite: 112 passed, 0 failed.
- Focused integration suites: 20 passed, 0 failed across route discovery,
  consumption reconciliation, governed workflow, server config, and the real
  Temporal cross-supervisor plus dependent-DAG proof.
- Full `bun run test:ci`: PASS with an empty named failure set.
- `bun run check`, `bun run build`, and `git diff --check`: PASS.
- The separately reported AI-CUR inspect-route `tool-not-enforceable` outcome is
  retained as a secondary routing observability/decomposition defect. It
  created no utility task or mutation and does not weaken this release gate.
