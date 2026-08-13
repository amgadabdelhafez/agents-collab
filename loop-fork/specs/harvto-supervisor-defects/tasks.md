# Tasks

## T1: intake and reproduction

- [x] Extract exact Harvto supervisor incidents into `runs/harvto-supervisor-defects/artifacts/defect-matrix.md` and park every unresolved item in Harness.
- [ ] Trace each report to current source and existing tests.
- [ ] Add a focused failing regression for every confirmed defect before changing production logic.
- [ ] Record refutations and duplicates with evidence instead of forcing a patch.

## T2: P0 fixes

- [ ] Correct confirmed delivery/unconsumed-peer regressions.
- [ ] Correct confirmed manifest/launch lying-liveness regressions.
- [ ] Run focused tests and record them with Harness.
- [ ] Commit, then obtain a zero-write Codex exact-SHA review when Claude drives, or the converse if roles switch.

## T3: P1 fixes

- [ ] Make no-worker routing terminate durably and visibly.
- [ ] Make bounded task completion emit durable supervisor-visible closure.
- [ ] Run focused tests and exact-SHA peer review.

## T4: P2 fixes

- [ ] Fix only P2 defects confirmed against the current baseline.
- [ ] Preserve model/effort/run identity across handoff.
- [ ] Reject stale write leases before mutation.
- [ ] Verify targeted recovery does not depend on an unsafe pane attachment assumption.

## T5: campaign close

- [ ] `bun run check`
- [ ] `bun test`
- [ ] `bun run build`
- [ ] `./harness preflight --json`
- [ ] `./harness stop-gate --json`
- [ ] Exact-SHA zero-write final review with findings resolved or explicitly recorded.
- [ ] Complete Harness bookkeeping without merging or pushing.
