PURPOSE

Request exact-SHA supervisor review of the context-pressure handoff restacked
onto the current installed handover lineage.

REQUESTED ACTION

Review the exact candidate SHA emitted by the governed stamped sender. Reply
CONCUR or provide blocking findings. No deployment or installation clearance is
requested.

LINEAGE

- Required current installed source: `67e622d0aee4ef331acec3cebc58e34f7f2ec292`.
- Reviewed feature source: `14687ce500e1fe28c4df0c94bb673d2857df2d73`.
- Candidate: supplied and verified by
  `loop-fork/evals/release/send-stamped-review.sh`.

COMBINED-LINEAGE RESULT

- Context-first pressure profiles, compaction precedence, preparation
  telemetry, and observe/off/enforce modes are present.
- Pressure activates only the existing governed handover controller.
- The newer handover guards remain present, including composer safety,
  trailing subagent-stop acceptance, exact idle-notification recognition,
  idempotent control delivery, validated bundles, and transaction-epoch
  preservation across restart.
- A new causal regression proves pressure pins epoch 41 before persistence,
  refuses a second lifecycle after reload, and retains transaction epoch 41
  when the restarted Governess fence advances to epoch 99.

PROOF

- Focused suites: session pressure 7, usage 22, Governess 77, handover 28;
  134 passed and zero failed.
- Mutation: removing epoch pinning makes the new regression fail on the exact
  `handoverEpoch` assertion; restoration returns 77/77 green.
- Lint, targeted TypeScript, compiled build, and complete sequential suite:
  pass.
- Governed verifier: pass with an empty named baseline failure list.
- The first sandboxed proxy integration could not bind localhost and surfaced
  `EADDRINUSE`; its isolated run and the uninterrupted complete suite passed
  with loopback binding allowed.

SAFETY AND LIMITS

- No installed binary or live run was changed.
- No direct restart, kill, `/compact`, or `/rename` path was introduced.
- This request does not authorize install, deploy, live-loop mutation, merge,
  rebase, or push.
