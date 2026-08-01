# Tasks: Bridge Overflow Delivery

- [x] T-01: Capture a real xchan message/dead-letter pair with source and byte
      provenance.
- [x] T-02: Derive target-scoped unreported dead letters from bridge events.
- [x] T-03: Return and durably report dead letters through `receive_messages`.
- [x] T-04: Add queue-health and bounded multi-batch regressions.
- [ ] T-05: Run focused and full verification, check, build, and create a passing
      `runs/bridge-overflow-delivery/eval.json`.
      Focused tests, scoped check, and build pass. The unsandboxed full suite is
      blocked on the four exact stale Codex expectation tests already corrected
      by unmerged commit `cca7bef`; the eval intentionally remains failed.
- [ ] T-06: Commit the bounded change and notify the supervisor. Do not deploy.
