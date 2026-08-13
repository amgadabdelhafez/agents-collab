# harvto-d5-silent-completion Plan

Mode: planned
Exact base: `6cdb9ad60e7c2b18926a70e25debf877302bc014`

## Objective

Make paired-run completion produce one durable supervisor-visible close attributable to the exact
repository, run, source-task SHA-256, and Git HEAD. Preserve it across restart and supervisor
delivery, and prevent duplicate closure on replay.

## Scope

- Paired-run completion/finalization ownership.
- Existing run manifest/transcript and supervisor bridge journal boundaries when required by the
  reproduced failure.
- Existing paired-loop, bridge, and run-state tests.
- D5-only contracts, evidence, evals, matrix row, root plan, and status.

## Proposed Tasks

### 1. Reproduce on unchanged base

- [x] Add one named paired-loop regression that reaches manifest `done` and expects one exact
      supervisor completion.
- [x] Record command, decisive red assertion, manifest/transcript state, and bridge rows.
- [x] Prove failed/stopped controls do not emit success.
- [x] Evaluate the `not-reproduced` exit. Exact-base red proved zero compliant closes, so the
      contrary-proof branch did not apply.

### 2. Implement narrow fail-closed ownership

- [x] Derive completion identity and failure semantics from red evidence. Bind manifest `repoId`,
      `workspaceBinding.root` with `cwd` fallback, `runId`, and `sourceTaskSha256` plus captured Git
      HEAD to the exact structured supervisor bridge row defined in the canonical spec and its
      taskId/threadId/dedupeKey.
- [x] Persist one exact close through current bridge transport.
- [x] Prove restart/replay and supervisor delivery cannot duplicate closure.

### 3. Verify and review

- [x] Run focused paired-loop, bridge, D1, D3, and D4 controls.
- [x] Read canonical ID from Harness status; run check, canonical typecheck, build, complete serial
      certification, Harness gates, both eval schemas, and root verifier.
- [ ] Commit explicit D5 paths and obtain Claude zero-write exact-SHA `PASS`.
- [ ] Close Harness once, commit bookkeeping, then continue to D16.

## Non-goals

- Harvto access, D6-D16 implementation, provider/model/dependency changes, paid utility work, new
  supervisor transport, tmux/prose completion detection, merge, rebase, push, deploy, or `.loop/`
  mutation.
