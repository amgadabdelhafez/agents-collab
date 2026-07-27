# Task utility-worker-runaway-guard

Created: 2026-07-27T16:04:00Z
Mode: planned
Description: Stop repeated denied-tool worker loops and bound emergency model-call runaways without reintroducing ordinary token or dollar budgets

## What I changed

- Captured the loop-53 runaway signature before implementation: 737 consecutive
  denied tool calls, 18,869,682 tokens, $3.99, and monthly-key exhaustion.
- Added the spec before source changes.
- Added a three-consecutive-broker-rejection breaker that resets on a broker
  success.
- Added a third-identical-call breaker that fails before executing the third
  call.
- Added an emergency ceiling that fails before provider call 65, while keeping
  the 15-minute external runtime bound and intentionally retaining no token or
  dollar cap.
- Added four local OpenAI-compatible endpoint regressions for the two breakers,
  rejection reset behavior, and the emergency ceiling.

## Why

The existing 15-minute runtime bound limits wall time but allows a denied tool
loop to spend heavily. Healthy jobs need more than the old 16-step limit, so the
fix targets no-progress behavior and retains a generous emergency ceiling.

## Notes

Regression: yes
Regression id: utility-worker-denial-runaway
Regression symptom: A broker-denied tool call was retried hundreds of times.
Regression guard: tests/loop/utility-runtime.test.ts

## Verification

- Focused utility runtime/store suite: 40 passed, 0 failed.
- Harness unit verification: pass.
- Build and `git diff --check`: pass.
- Full suite: 894 passed, 4 pre-existing failures caused by hard-coded Codex
  defaults (`gpt-5.5` / `fast`) that do not match the committed runtime defaults
  (`gpt-5.6-sol` / `standard`). No runaway-guard test failed.
- Independent evaluator: PASS; no blocking findings. The four stale default
  expectations are unrelated and remain outside this patch.
- Installed candidate, canonical, and global binaries match SHA-256
  `68ec17520d640f6fee57ccc4061a892bda0462aca04a1cef5bdcc6ff8450b3e4`.
- Used an atomic executable replacement after macOS killed the first in-place
  overwrite due to the existing executable inode. The installed CLI now runs,
  loop-53 governess doctor is fully green, and all seven pane PIDs, dimensions,
  and titles are preserved exactly.
