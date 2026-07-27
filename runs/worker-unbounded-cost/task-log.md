# Worker unbounded cost task log

- 2026-07-26: Diagnosed live loop 47 job `4fd7f78a`: 3 model calls, 8 tool
  calls, 16,970 cumulative tokens, then `worker job exceeded its total token
  limit`. No bridge, claim, or provider failure was involved.
- Raised defaults to 8,000 completion tokens per call and 64,000 cumulative
  tokens per job; retained environment overrides.
- Removed worker-specific per-job and per-run dollar routing reservations and
  the reported-cost execution abort. Cost remains journaled and displayed.
- Preserved step, runtime, tool-output, filesystem, protected-path, command,
  credential, authority, write-conflict, and patch-application boundaries.
- Focused router/runtime/tool tests: 70 pass. Full suite: 798 pass with the same four
  known Codex model/config expectation failures. Build and diff check pass.
- Final audit removed the dormant generic router `budget-exceeded` branch and
  its tier/run budget fields, so no dollar estimate can gate routing anywhere.
- A second live job (`62dcd839`) exposed a separate 8-step failure caused by
  repeated denied attempts to run literal `git` through `run_check`. Raised the
  conversation default to 16 steps and extended the shell-free `git_diff` tool
  with validated literal commit hashes, changed-file mode, and diff-check mode.
- Canonical rebuilt and loop 47 governess narrowly respawned as PID 94680.
  Claude PID 56784, Codex PID 56786, and worker pane PID 21402 remained
  unchanged. No worker job is queued or active and bridge pending is zero.
- Follow-up operator decision removed token limits entirely: worker requests no
  longer send `max_tokens`, runtime has no cumulative token abort, and the old
  token environment controls/help entries are gone. A provider response
  reporting one million tokens per call completes in regression coverage.
- During verification, Codex decision `9825d7f4` was found already acted on by
  Claude but still pending in the bridge. The worker subsequently recorded it
  delivered, then delivered the newer wind-down ACK once. Both IDs now have one
  durable delivery record and bridge pending is zero.
