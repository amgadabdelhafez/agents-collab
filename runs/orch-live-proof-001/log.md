# ORCH-LIVE-PROOF-001 log

- Bound from reviewed orchestration control-surface closure
  `2c5d842353e993a81e1162b1204bf38587ff2126`.
- `TemporalSupervisorRuntimeHost` now creates one `TaskGraphRuntime` from the
  same `TemporalWorkflowPort` as SupervisorMessage and exposes an authenticated
  Fetch handler composed from both canonical runtimes.
- The staged proof used Temporal's real local test server. Harvto submitted one
  governed message, delivery ran automatically once, Harness claimed and
  acknowledged it, and the durable thread, Attention, and knowledge projections
  reflected the same workflow.
- The same handler started a sorted two-node graph. `consumer` remained blocked
  until `foundation` completed with its exact acceptance receipt, then both
  nodes completed under the authenticated Harness worker identity.
- Focused real-Temporal proof: 1 passed / 0 failed / 25 assertions.
- `bun run check`, `bun run build`, and `git diff --check`: PASS.
- `bun run test:ci`: PASS with an empty named failure set.
- Earlier proof attempts correctly exposed two fixture errors: delivery
  idempotency is derived from the durable workflow identity, and graph nodes
  must be sorted. Both test claims were corrected without product broadening.
