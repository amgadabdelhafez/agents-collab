# D-009: Helper evidence reliability

## Status

Queued for a fresh isolated governed loop. Do not implement this defect in the
tmux-socket-normalization worktree.

## Confirmed failure

Nanny completed work without repository evidence and later made a false
zero-`process.env` claim. Au Pair exposed an unsatisfiable `run_check` working
directory and exhausted three broker-rejected rounds. Deterministically bounded
packet rejection also leaves useful-utilization counters unable to distinguish
valid null findings from routing failure.

Run 19 supplied two additional producer-backed failures. Task
`cc40ad93-b2b5-488a-8c96-cc9b258c6617` claimed its source artifact was a valid
unified diff, while independent `git apply --check` failed as corrupt at line
44. Read-only audit task `3add9934-1ff2-4c42-8fa0-fee570d9746d` reached
`completed` with a raw `<tool_call>read_file...` fragment as its entire result
instead of the requested audit. Neither outcome is usable evidence.

Run 20 supplied a third producer-backed failure. A routed search-profile packet
reported `specs/tmux-socket-normalization` empty even though the untracked tree
contained four files totaling about 120 KB. The helper's git-backed search
silently excluded untracked files, so its clean negative result did not cover
the declared filesystem scope.

Harvto run 169 supplied a fourth helper-pipeline failure. Au Pair edit task
`5c7faced` reached `completed` after about 16 minutes and delivered patch
artifact SHA `f21ce19e` with manifest SHA `30af2a81`, but independent
`git apply --check` reported `corrupt patch at line 599`. The hunk header
`@@ -433,3 +437,205 @@` declared an addition count not present in the emitted
body, consistent with a truncated long model stream. Guarded apply correctly
rejected it and verified the target preimages unchanged, but the producer had
already recorded a false successful terminal state. The preceding task
`4264d75f` separately failed closed with `Stream ended without finish_reason`.

## Required behavior

- A null result needs producer evidence over the full declared scope.
- Routing or execution rejection is a failure outcome, never a successful null
  finding.
- A patch-validity claim requires a producer or independent `git apply --check`
  over the exact artifact and preimages; prose saying `valid unified diff` is
  not evidence.
- Validate every emitted patch with `git apply --check` or exact hunk
  header/body reconciliation before publishing the artifact or marking its
  task `completed`; truncated or structurally inconsistent output must fail
  closed at the producer.
- Tool-call markup or an unfinished model action cannot become a successful
  terminal audit result.
- Claims over source sets must derive and record the searched set and command.
- A filesystem-scope search must include tracked and untracked regular files;
  a git-only search must fail closed or declare its narrower tracked scope.
- Useful-utilization metrics must separate applied evidence, valid refutation,
  invalid packet, routing rejection, and execution failure.

## Regression evidence required

- Producer-backed positive, valid-null, invalid-packet, and execution-failure
  fixtures with distinct durable outcomes.
- A false zero-match claim fails when any bounded source member matches.
- An untracked-only fixture fails any helper that reports a filesystem-wide
  zero-match result from git-backed enumeration.
- Corrupt-patch and raw-tool-call terminal fixtures are classified as failed,
  never useful or completed evidence.
- A stream truncated inside a large hunk cannot publish a completed patch;
  producer validation records a failed terminal outcome while preserving exact
  target preimages.
