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
