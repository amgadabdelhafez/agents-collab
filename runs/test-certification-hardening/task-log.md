# Test certification hardening task log

## Bare-suite investigation

- The reviewed exit-133 symptom did not reproduce in three local direct-suite
  attempts; each completed 1,263 tests with zero failures before this slice.
- Bun's preload receives `process.argv`, `Bun.argv`, and `Bun.main` rewritten to
  the first discovered test file for both focused and bare invocations. The
  original selector set is therefore unavailable inside `tests/setup.ts`.
- Direct `bun test tests/loop/utils.test.ts` now exits 2 before any `(pass)` line
  and points to the explicit focused and full-suite commands.
- `bun run test:file -- <file>` opts into one file, while `bun run test:ci`
  starts one fresh Bun process for every sorted test file.

## Verification evidence

- Focused guard regression: 1 pass, 0 fail.
- Utility-readiness regression: 5 pass, 0 fail.
- Full sorted suite: 1,264 pass, 0 fail.
- Forced redraw failure: exit 97 after healthy tick 1; state and pane tail
  printed; evidence preserved at
  `/private/tmp/loop-redraw-cert.EB1WKp/tmux-redraw.09ik03`.
- Redraw success cleanup: generated smoke directory absent after success.
- Redraw repetition: 6 pass, 0 fail; every run reached tick 3 with tmux control
  restored.
- Lint, typecheck, compiled build, and `git diff --check`: pass.

## Scope

No live run, routing policy, helper permission, or installed binary was changed
by this slice. The earlier independently authorized `4c3752b` canonical deploy
was announced separately and run-101 activation remained deferred.
