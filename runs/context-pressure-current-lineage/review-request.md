READY FOR GOVERNED STAMPED SEND

PURPOSE

Request exact-SHA supervisor review of the context-pressure handoff restacked
onto the current supervisor-concurred handover lineage.

REQUESTED ACTION

Review the exact candidate SHA emitted by the governed stamped sender. Reply
CONCUR or provide blocking findings. No deployment or installation clearance is
requested.

LINEAGE

- Required supervisor-concurred source:
  `c842fac05aba5d5eb3658704d537ab1022a1916a`.
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
  preservation across restart, exact frozen effort carry, continuation digest
  binding, and one-time restart-frame reconciliation.
- A new causal regression proves pressure pins epoch 41 before persistence,
  refuses a second lifecycle after reload, and retains transaction epoch 41
  when the restarted Governess fence advances to epoch 99.
- An asymmetric non-default driver-high/reviewer-low fixture proves exact role
  efforts reach both the digest-bound manifest and replacement argv.

PROOF

- Five focused files passed 149 tests, 0 failures, and 761 expectations.
- `bun run test:ci` passed every sequential test file outside the restricted
  sandbox. The restricted attempt reached the proxy integration before a
  localhost ephemeral-port bind was refused; the unrestricted mandatory run
  passed that integration and all remaining files.
- `bun run check`, the governed targeted TypeScript check, `bun run build`,
  and `git diff --check` passed.
- `scripts/verify.sh context-pressure-handoff
  context-pressure-current-lineage` passed lint, typecheck, build, every
  sequential test file, and the empty named baseline allowlist.
- Removing epoch pinning failed the named epoch-41 producer regression.
- Hardcoding persisted driver effort to medium failed the named asymmetric
  driver-high/reviewer-low producer regression.
- Both named tests passed after restoring production behavior.

SAFETY AND LIMITS

- No installed binary or live run was changed.
- No direct restart, kill, `/compact`, or `/rename` path was introduced.
- This request does not authorize install, deploy, live-loop mutation, merge,
  rebase, or push.
