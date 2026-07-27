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

## Why

Run 51 showed that most remaining Claude load was mechanical but outside the
old grammar. These families can be expressed without a general shell or model-
selected executable.

## Notes

- Red proof: 263 pass / 19 expected fail before implementation.
- Focused green: 320 pass / 0 fail; latest Harness unit attempt passed.
- Full suite: 983 pass / 4 baseline fail; the same four failures were
  reproduced on `e97b206` before the two final regression tests were added.
- Build and diff check pass; built SHA-256 is
  `7e85ab9389435784f145a549c37a3faa3846e22dbd784e5f56da2e59d8e80ca7`.
- Changed-file static diagnostics match base exactly: 33 errors / 1 warning.
