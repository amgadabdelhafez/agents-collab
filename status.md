# status — gov-6: governess journal becomes a read model over Temporal history

Branch `codex/gov-6-journal-to-temporal`, base `80823678`. Work in `loop-fork/`.

## State: implementation complete and verified; awaiting Oss review, then PR.

## What this session did

- Decided the charter's open question: **one beat workflow per run, not per
  seat**, because the idempotency fence, the `sequence` counter, and observation
  dedupe are all run-global. Reason recorded in the commit message, PLAN.md,
  `governess-beat-workflow.ts`, and the runbook. Oss approved.
- Extracted the pure decision reducer to `src/loop/governess-journal-core.ts`,
  shared by the JSONL writer and the workflow, so journal equality is a property
  rather than a coincidence. The core imports no Node built-ins — a `node:crypto`
  import there broke the webpack workflow bundle, so hashing moved to the callers
  (this also removed a double-hash bug on the workflow path).
- Added `src/loop/governess-beat-workflow.ts`: the `governess-beat.v1`
  `WorkflowDefinition`, with a signal-boundary fence that rejects a prompt body.
- `governess-journal.ts` now delegates to the core and exports the read model
  (`governessJournalFromHistory`, `serializeGovernessJournal`).
- Registered the beat workflow in `temporal-workflow.ts`, declared it in
  `loop-orchestration-server.ts` as `LOOP_ORCHESTRATION_WORKFLOW_TYPES`, and
  regenerated the pinned bundle with `bun run build:temporal-workflow`.
- CLI: `loop governess history <runId>`.
- Retirement markers in place, nothing deleted.
- Created `docs/RUNBOOK-LOOP.md` (it did not previously exist).

## Proof run

- `bun run check`: clean, 916 files.
- `bun run test:ci`: **112 files / 1959 pass / 0 fail**, 0 skipped.
  Verified all 112 files ran by counting `bun test v` banners, not summary lines
  (13 files print the singular "Ran 1 test", which a naive regex misses).
- Named files run individually: `governess-beat-workflow.test.ts` 6 pass,
  `dbos-workflow-port.test.ts` 4 pass, `governess-runtime.test.ts` 15 pass.
- All three named checks mutation-tested; see the table in PLAN.md.

## Traps hit, recorded so the next session does not repeat them

1. `tests/loop.test.ts` fails 3 tmux tests when `TMUX` is inherited. Not a
   regression: `env -u TMUX` gives 43 pass / 0 fail. Always run the suite with
   `env -u TMUX -u TMUX_PANE`.
2. A backgrounded `nohup ... &` reports the *launcher's* exit code, not the
   suite's. The first "exit 0" was false; the run had actually stopped at the
   first failing file. Run the gate in the foreground and read its real exit.
3. The routed Au Pair edit packet came back as a `new file mode` patch against
   `/dev/null` that would have replaced two retired files with just a comment,
   deleting their bodies. Cause: the worker's workspace root is the worktree root
   (`gov-6/`), but the sources live under `gov-6/loop-fork/`. Patch rejected, not
   applied; markers written natively. **Route packets with paths relative to the
   worker's root, and always read the returned diff before applying.**
4. `route_task` rejects read/inspect packets as "not deterministically bounded";
   native reads auto-delegate anyway. Edit packets are accepted.

## Open items / next steps

1. Ask Oss for implementation review (design was already approved).
2. After review passes, open the draft PR against this branch.
3. gov-7 (cutover) inherits: delete the retired files, move the surviving
   governess utility commands off the JSONL journal, point
   `loop governess history` at live Temporal history instead of the JSONL
   projection, and decide the `ContinueAsNew` boundary for unbounded run history.
