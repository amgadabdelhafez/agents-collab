# Handover effort fidelity and restart reconciliation task log

## Cleared lineage

- Supervisor order: `71fdfec7-0aaa-4a86-b364-892dbecceb20`.
- Base: `67e622d0aee4ef331acec3cebc58e34f7f2ec292`.
- Branch: `codex/handover-fidelity-dedup`.
- Worktree: `/private/tmp/agents-collab-handover-fidelity-dedup`.

## Diagnosis

- Run 131 reviewer command contained `model_reasoning_effort=high`; run 132
  replacement contained `model_reasoning_effort=medium` because replacement
  argv omitted the predecessor's role-specific effort values.
- The persisted Governess state contains no agent or helper row collection.
  Exactly one live row per entity is constructed each tick, and all policy and
  accounting consumers use that current row set.
- The duplicate Codex and byte-identical au-pair rows observed after Governess
  restart were stale alternate-screen terminal content, not duplicated domain
  state or doubled enforcement inputs.

## Authority boundary

This task may produce and verify an isolated exact-SHA candidate. It may not
install, deploy, merge, push main, or mutate healthy run 132.

## Implementation

- Governess config resolves `driverEffort` and `reviewerEffort` from the run
  manifest with the launch default only for legacy manifests.
- The handover transaction writes the continuation before the manifest. The
  manifest digest binds both effort values, continuation path/hash, epoch, and
  all bundle paths/hashes; readers reject changed effort, continuation, or
  bundle bytes.
- Replacement argv receives only the validated frozen effort values.
- Renderer startup emits one `CSI 3 J` scrollback erase and one `CSI 2 J`
  viewport erase before the live frame; subsequent frames retain line deltas.

## Verification

- Focused suites: Governess runtime 13/13, handover/exit 29/29, Governess board
  74/74.
- Tamper negatives: changed reviewer effort, continuation bytes, and bundle
  bytes all invalidate the transaction.
- Full sorted `bun run test:ci`: uninterrupted pass outside the restricted
  localhost sandbox; no tolerated failures.
- `bun run check`, governed typecheck, compiled build, and `git diff --check`:
  pass.
- The first sandboxed full attempt stopped only at the localhost proxy fixture
  with `EADDRINUSE`; that exact fixture and the complete suite passed with
  normal localhost access.
