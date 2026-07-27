# Task log: automatic-worker-tool-widening

## Baseline

- Live run 51 had 88 Claude Bash calls: 16 focused tests, 12 searches, 12
  bounded file slices, and 9 directory inspections. Existing automatic routing
  covered only a small subset and could not preserve a focused-test cwd.
- The pre-implementation focused suite produced 19 expected failures and 263
  passes. Failures were limited to the new cwd, profile, classifier, listing,
  tail-read, workspace, and hook expectations.

## Implementation

- Added exact structured `executionArgv` and `executionCwd` request metadata,
  stable persistence, protected-path routing gates, and verified linked-worktree
  normalization.
- Added one-tool `focused-check` and `file-list` profiles.
- Added filesystem-native `list_files` with exact-directory authority,
  protected-entry filtering, no recursion, no symlink following, and shared
  entry/output limits.
- Added bounded `read_file.lastLines` support.
- Added exact automatic grammars for focused Bun/Vitest file-filtered tests,
  safe one-directory `ls`, literal `grep`, exact AWK line selectors, and bounded
  `tail` reads. Exact `2>&1` is recognized without granting general redirects.
- Focused checks use an exact cwd, exact argv, exact file scopes, the local
  Vitest binary, offline npx, a sanitized environment, a 60-second timeout,
  and the existing 64 KiB output cap.
- Persisted exact read and output boundaries are broker-enforced: models cannot
  widen AWK/tail ranges, exceed 500 lines, drop `head`/`tail`, or reinterpret
  the accepted stderr merge/omit marker.

## Verification so far

- Focused suite: 320 passed, 0 failed; latest Harness unit attempt passed.
- Build: passed (`bun run build`), SHA-256
  `7e85ab9389435784f145a549c37a3faa3846e22dbd784e5f56da2e59d8e80ca7`.
- Diff check: passed (`git diff --check`).
- Full suite: 983 passed, 4 failed. The same four Codex-local-configuration
  failures reproduce unchanged on base commit `e97b206`; they expect the old
  `gpt-5.5` and config argument shape while the live configuration uses
  `gpt-5.6-sol`, `xhigh`, and `standard`.
- Static check: changed-file diagnostics equal the base exactly (33 errors and
  1 warning); repository-wide formatting/static debt remains pre-existing.
- Independent adversarial review: passed with no remaining blockers after
  broker-enforced fixes for oversized checks, grep option injection, exact
  read ranges, 1-4 focused-file limits, and structured output filtering.

## Remaining

- Remaining Harness live-runtime gate.
- Commit, deploy the independently verified binary, scoped governess/worker
  pane restart, live focused-check and inspection canaries, PID preservation,
  and governess doctor.
