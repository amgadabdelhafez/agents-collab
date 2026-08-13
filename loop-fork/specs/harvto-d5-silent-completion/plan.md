# D5 Durable Supervisor Completion Plan

## Approach

1. Confirm base `6cdb9ad60e7c2b18926a70e25debf877302bc014`, canonical D5 identity, active
   Harness state, and preserved `.loop/`.
2. Trace paired completion from done signal through manifest/transcript finalization and durable
   supervisor bridge enqueue/delivery.
3. Add one named regression in the existing paired-loop boundary while production remains
   unchanged. Prove manifest `done` plus zero matching supervisor closure.
4. Record exact-base red output and the relevant manifest, transcript, and bridge rows before any
   production correction.
5. If unchanged production already emits one exact durable supervisor close, record
   `not-reproduced` with contrary manifest/transcript/bridge proof and skip production edits.
6. Assert exact identity: source `repoId`, `workspaceBinding.root`/bound `cwd`, `runId`, and
   `sourceTaskSha256` from `manifest.json`; capture `gitHead` from the bound repository before
   terminalization; require the same four values in the structured supervisor `bridge.jsonl`
   message and bind `taskId`, `threadId`, and `dedupeKey` to that identity. Prefer
   `workspaceBinding.root`, fall back to `cwd`, and use the exact completion-record shape in
   `spec.md`.
7. Set the final transition contract from evidence: attribution fields, durable owner, failure
   behavior, dedupe identity, restart repair, and delivery/replay semantics.
8. Implement the smallest fail-closed correction at that owner. Reuse existing durable bridge and
   run-state primitives unless reproduction proves a narrow schema addition is required.
9. Re-run the unchanged regression plus failed/stopped/no-duplicate/restart/supervisor-drain
   controls and D1/D3/D4 regressions.
10. Read canonical identity from `./harness status --json`; run check, canonical TypeScript, build,
   complete serial `bun run test:ci`, Harness preflight/stop-gate, and the root verifier. Maintain
   Harness `runs/<task-id>/eval.json` with passing dimensions and repository-root
   `../runs/<task-id>/eval.json` with exact `verdict: "pass"` and empty `baseline_failures`.
11. Derive scope from Git, commit explicit D5 paths, obtain Claude zero-write `PASS` on the exact
   SHA, correct only D5 findings, then close Harness once and commit lifecycle bookkeeping.

## Candidate implementation seams

- `src/loop/paired-loop.ts`: `transitionRunState` and `finishRun` currently persist completion only
  to the run manifest/transcript.
- `src/loop/bridge-store.ts`: existing supervisor target, durable journal, delivery resolution, and
  pending-only dedupe may be reused or narrowly strengthened if delivered replay duplicates.
- `src/loop/run-state.ts`: existing `runId`, `repoId`, `sourceTaskSha256`, workspace binding, and
  terminal state supply durable attribution; extend only if a crash-safe completion identity must
  be persisted atomically with terminal state.
- `tests/loop/00-paired-loop.integration.test.ts` or `tests/loop/paired-loop.test.ts`: existing
  end-to-end completion and supervisor-pending assertions provide the smallest deterministic red
  boundary. Reproduction selects one.

## Rejected designs

- Console output, pane prose, heartbeat, or notification as completion proof.
- A non-durable callback or a second supervisor ledger.
- Success without exact run/task/Git attribution.
- Pending-only dedupe that emits another close after supervisor delivery and replay.
- Emitting success for failed, stopped, input-required, or max-iteration runs.
- Provider/model changes, paid utility work, tmux sleeps, broad bridge redesign, or D6-D16 edits.
