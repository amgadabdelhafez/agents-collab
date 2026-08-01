# Tasks: Governess Exit-Request Control

- [x] T-01: Record the run-109 symptom and distinguish observed facts from the
      unproven stdin root cause.
- [x] T-02: Specify the Governess-owned append-only request and receipt protocol.
- [ ] T-03: Reconcile the registered-process cleanup and named-baseline
      prerequisites on the implementation branch.
- [ ] T-04: Implement strict request storage, deduplication, and epoch fencing.
- [ ] T-05: Implement `loop stop --run-id <id>` with bounded positive completion.
- [ ] T-06: Poll and execute requests from the live Governess tick without using
      stdin or introducing a second teardown owner.
- [ ] T-07: Add producer-bound and isolated lifecycle verification.
- [ ] T-08: Obtain exact-SHA independent review and activate next-loop only.
