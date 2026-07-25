# Plan: Governess Runtime

1. Establish the canonical rename and narrow legacy compatibility boundary.
2. Add the domain protocol: lifecycle events, runtime adapter, action policy,
   fenced lease and durable control journal.
3. Integrate the protocol into observation, delivery, recovery, role changes
   and exit/handoff orchestration.
4. Add verified handoff bundles plus replacement readiness acknowledgement.
5. Add side-effect-free replay and doctor commands.
6. Add migration, invariants, lifecycle and failure-path tests.
7. Run focused/full verification, independent evaluation and a narrow live
   governess-pane deployment.
8. Consolidate the duplicate runtime and activity tables into one compact row
   per agent, then verify visible-width and ordering invariants.
