# Claude warning producer fixture

- Captured Claude Code 2.1.220 startup at 220x60 with no prompt submission.
- Stored raw output privately and committed only deterministic normalized frames.
- Reproduced the pre-fix launcher timeout on the captured ready composer.
- Rejected the first cursor-only patch after independent review reproduced a
  matching human draft false-positive and a text/cursor TOCTOU.
- Added a single-command-queue state snapshot plus a quiet, activity-acknowledged
  `End,C-l` probe; detected drafts are restored with acknowledged `Home,C-l`.
- Preserved exact executable red-before evidence: the final regression test on
  base `fb926edf` exits 1 at the original 20-second readiness timeout.
- Recaptured the producer proof until readiness, draft reveal, and draft cursor
  restoration each had a distinct `window_activity` acknowledgment.
- Preserved any post-probe uncertainty as a live `input-required` workspace;
  startup no longer kills a possible human draft after End delivery or timeout.
- Expanded focused coverage to 87 passing tests. Ultracite, source typecheck,
  compiled build, the complete sequential suite, and the empty baseline gate
  pass. No Loop run or installed binary has been changed yet.
- Harness unit, provenance, focused, build, full, and hash-bound release
  dimensions pass; preflight and stop-gate passed before the task was closed.
