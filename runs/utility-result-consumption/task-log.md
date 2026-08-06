# Task Log: Utility Result Consumption

- 2026-08-06: Confirmed on run 139 that two results read through
  `get_task_result` remained pending in the bridge ledger and reconciliation
  pane.
- 2026-08-06: Started an isolated branch from cleared `origin/main`
  `0f69b9a99f9163bf9f83075530e26aed21258463`.
- 2026-08-06: The producer-backed regression failed on the unmodified source:
  the matching handover remained as a fourth pending bridge message.
- 2026-08-06: Reused the exact bridge inbox consumer at `get_task_result`,
  bounded by caller, utility source, handover type, exact task ID, and absence
  of an active delivery claim.
- 2026-08-06: Three causal/safety cases pass; the complete bridge file passes
  109 tests; formatting, typecheck, build, and the mandatory sequential suite
  pass with an empty named failure set. The loopback integration file was also
  rerun independently with port authority after sandbox binding produced a
  false `EADDRINUSE` result.
