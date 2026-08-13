# D5 Durable Supervisor Completion

## Goal

Make paired-run completion produce one durable supervisor-visible close signal attributable to the
exact repository, run, source task, and Git commit. The signal must survive restart and replay,
and repeated completion processing must not create a second effective close.

## Exact base

`6cdb9ad60e7c2b18926a70e25debf877302bc014`

## Scope

- `src/loop/paired-loop.ts` completion transition and finalization ownership.
- Existing run manifest/transcript and bridge journal primitives only if exact attribution or
  replay-safe completion requires a narrow extension.
- Existing paired-loop, bridge, and run-state test boundaries.
- D5-only Harness evidence, defect-matrix row, evals, `PLAN.md`, and `status.md`.

No Harvto reads or edits, other defect implementation, dependency/provider/model changes, UI
changes, merge, rebase, push, deploy, release, spending, or `.loop/` mutation.

## Invariants

1. A paired run cannot be durably `completed` while lacking one supervisor-visible completion
   record for the same repository and run identity.
2. Completion identifies the exact run ID, source-task SHA-256, and Git HEAD that was completed;
   missing or malformed attribution fails closed instead of emitting ambiguous success.
3. The completion record is append-only and survives process restart and supervisor polling.
4. Restart, replay, duplicate finalization, and supervisor delivery produce at most one effective
   completion for the same completion identity.
5. Failed, stopped, max-iteration, input-required, and review-failed runs do not emit success.
6. Existing agent-to-agent and supervisor bridge delivery, D1 retention/liveness, D3 routing, and
   D4 peer-response behavior remain unchanged.

## Reproduction rule

Add the smallest named paired-loop regression against unchanged base. Bind a deterministic source
task identity and current Git HEAD, complete the run, prove the manifest is `done`, then assert that
the supervisor inbox contains one exact attributable completion. Current code is expected to fail
because it only updates the manifest/transcript. Preserve the exact command, decisive assertion,
manifest state, and bridge journal. If current code already emits a compliant close, record exact
contrary proof and make no production edit.

## Completion record

Repository-root precedence is deterministic: use `manifest.workspaceBinding.root` when present;
otherwise use `manifest.cwd`. Before terminalization, resolve Git HEAD from that root. The durable
`bridge.jsonl` close is a `kind: "message"`, `target: "supervisor"`, `type: "ack"` record with
subject `paired run completed`. Its JSON message has `kind: "paired-run-completed"`, `repoId`,
`repositoryRoot`, `runId`, `sourceTaskSha256`, `gitHead`, and `status: "completed"`. `taskId` equals
`sourceTaskSha256`; `threadId` equals `<repoId>:<runId>`; and `dedupeKey` equals
`paired-run-completed:<repoId>:<runId>:<sourceTaskSha256>:<gitHead>`. Missing attribution or Git
resolution prevents both the close and healthy terminal state.

## Compatibility

Prefer current run manifest, bridge message, dedupe, and delivery schemas. Do not add polling,
provider calls, tmux dependence, synthetic success, unbounded retention, or a second supervisor
transport. Legacy manifests and journals must remain readable.
