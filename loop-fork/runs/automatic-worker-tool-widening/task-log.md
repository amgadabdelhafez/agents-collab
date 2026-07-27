# Task automatic-worker-tool-widening

Created: 2026-07-27T06:33:02Z
Mode: planned
Description: Safely auto-route focused tests and broader bounded repository inspection to GLM-5.2

## What I changed

- Added structured exact argv/cwd persistence and verified workspace adoption.
- Added exact focused-check and file-list execution profiles.
- Added bounded nonrecursive listing and tail-read broker capabilities.
- Added conservative focused test, ls, literal grep, AWK, and tail classifiers.
- Enforced exact test argv, cwd, and file authority at the broker boundary.
- Enforced 1 MiB check inputs, 500-line exact reads, 1-4 test files, trailing
  grep-option rejection, and structured output/stderr bounds at the broker.
- Fixed the live-discovered multi-worker claim race with bounded lock retry,
  fresh-empty lock protection, owner-token cleanup, and stale-age recovery.

## Why

Run 51 showed that most remaining Claude load was mechanical but outside the
old grammar. These families can be expressed without a general shell or model-
selected executable.

## Notes

- Red proof: 263 pass / 19 expected fail before implementation.
- Focused green after the concurrency fix: 334 pass / 0 fail.
- Full suite: 987 pass / 4 baseline fail; the same four failures were
  reproduced on `e97b206`.
- Build and diff check pass; independently reviewed binary SHA-256:
  `0e80de544f426bcd787cb234949217b065b7661a8a53eaf252048bfef63662a7`.
- Changed-file static diagnostics match base exactly: 38 errors / 1 warning;
  the five additional diagnostics come from newly included utility-store files
  and are unchanged from commit `9e12134`.
- Live run 51 passed concurrent automatic `file-list` and `focused-check`
  canaries on distinct worker PIDs with one successful expected tool call each,
  zero denied calls, 19/19 focused tests, unchanged Claude/Codex PIDs, green
  governess doctor, and populated cost cells across refreshes.
