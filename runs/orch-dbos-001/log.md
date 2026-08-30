# ORCH-DBOS-001 log

- 2026-08-30T04:27:00Z: Created isolated branch `codex/orch-dbos-001` from
  accepted Temporal closure `ebdd8707a3192315ff28d96eea2ba2d5ef7cd47e`.
- 2026-08-30T04:28:00Z: Bound the DBOS comparison contract before dependency or
  source mutation. Official DBOS documentation requires Node 20+ and PostgreSQL
  for integration testing; the current stable npm release is 4.27.6. Unit mocks
  are explicitly insufficient for this conformance claim.
- 2026-08-30T05:04:00Z: Pinned `@dbos-inc/dbos-sdk` 4.27.6 and PostgreSQL 17
  Alpine image digest
  `sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73`.
  Added a registered DBOS workflow, engine-neutral port adapter, and isolated
  replay runtime.
- 2026-08-30T05:31:00Z: Rejected the initial in-process restart instrument.
  `DBOS.shutdown()` is a graceful teardown and caused indefinitely waiting
  workflows to observe database shutdown, so it did not verify crash recovery.
  Replaced it with an actual child DBOS worker process and hard process loss;
  PostgreSQL and executor identity remain stable across same-version restart.
- 2026-08-30T05:38:00Z: Focused comparison PASS 3/0. The first five unchanged
  fixtures matched their frozen exact digests. In `worker-upgrade`, the v1
  workflow remained durably `PENDING` with application version
  `supervisor-message.v1-worker`; the live v2 runtime could not recover it and
  the exact `signal-claim-1` observation timed out. This is the comparison
  result, not a substituted same-version relaunch.
- 2026-08-30T05:41:00Z: Full `bun run test:ci`, `bun run check`, `bun run build`,
  and `git diff --check` PASS with an empty named failure set. No PostgreSQL
  comparison container remained running after the gates.
