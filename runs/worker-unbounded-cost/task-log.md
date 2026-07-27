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
- Focused router/runtime tests: 54 pass. Full suite: 798 pass with the same four
  known Codex model/config expectation failures. Build and diff check pass.
