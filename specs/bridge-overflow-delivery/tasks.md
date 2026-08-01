# Tasks: Bridge Overflow Delivery

- [x] T-01: Capture a real xchan message/dead-letter pair with source and byte
      provenance.
- [x] T-02: Derive target-scoped unreported dead letters from bridge events.
- [x] T-03: Return and durably report dead letters through `receive_messages`.
- [x] T-04: Add queue-health and bounded multi-batch regressions.
- [x] T-05: Serialize concurrent receivers with a stale-recoverable per-message
      report claim and prove that exactly one process emits the dead letter.
- [ ] T-06: Run focused and full verification, check, build, and create a passing
      `runs/bridge-overflow-delivery/eval.json`.
      Focused tests, scoped check, and build pass. The unsandboxed full suite is
      blocked on the four exact stale Codex expectation tests already corrected
      by unmerged commit `cca7bef`; the eval intentionally remains failed.
- [ ] T-07: Commit the bounded change and notify the supervisor. Do not deploy.
