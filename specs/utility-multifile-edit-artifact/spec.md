# Spec: Atomic Multi-file Au Pair Edits

## Problem

An Au Pair edit job can call `propose_patch` once per file. The job then exposes
multiple valid diff artifacts, while guarded application records only one
application per job. After the first artifact is applied, the second is refused
as a different application. In loop 122 this caused Claude to delete the
Au Pair-authored file and rewrite both requested files itself, so recorded Au
Pair activity did not reduce driver coding load.

## Goal

Every completed Au Pair edit job exposes exactly one guarded diff artifact,
including when the model proposes multiple file patches, so one reviewed
`apply_task_patch` call atomically applies the complete edit.

## Requirements

1. Tell the utility model to put every file diff for one edit job in one
   `propose_patch` call.
2. Do not trust prompt compliance. If the model still produces multiple valid
   patch artifacts, combine them and pass the combined patch back through the
   existing broker validation before completing the job.
3. Expose only the validated combined diff in the completed job result. Keep
   the individual proposal files as audit evidence, but do not advertise them
   as independently applicable results.
4. Preserve the single guarded application record, preimage checks, declared
   write scope, protected-path checks, and main-agent-only application rule.
5. If the combined patch cannot pass existing validation, fail the worker job
   closed rather than returning a partially applicable edit.

## Acceptance criteria

- A producer-backed worker test emits two `propose_patch` calls for two new
  files and the completed job contains exactly one diff artifact.
- That single artifact contains both file diffs and one guarded apply creates
  both files.
- Existing focused utility runtime and tool tests pass.
- Full repository verification remains green.

## Non-goals

- Letting Au Pair apply its own changes.
- Allowing multiple independent application records for one job.
- Weakening patch scope, integrity, preimage, or protected-path validation.
