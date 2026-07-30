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

## Exact-SHA DISSENT and correction

Supervisor review `af47b3b2-60ab-44c8-ae08-b76d7477db00` correctly rejected
`344ee6e`: the large-prompt smoke still invoked direct `bun test`, and the
redraw preservation trap armed after fallible bootstrap work.

- The large-prompt smoke now invokes its filtered test through
  `bun run test:file --`; the complete realistic launch passed with named
  panes, manifest binding, hash mismatch fail-closed, and missing-workspace
  exit 1.
- Redraw cleanup now arms before repository and tmux discovery, disables
  errexit while diagnosing, preserves the original status, and converts
  HUP/INT/QUIT/TERM into catchable 128+signal exits.
- Missing-tmux bootstrap exit 1, forced root-stage exit 96, and TERM exit 143
  each printed and retained a generated evidence tree.
- The first real 14-run sample reproduced one organic failure and preserved it
  at `/private/tmp/loop-redraw-organic-live.f6ZsMT/run-1/tmux-redraw.iuK3n8`.
  Its pane showed the long Governess command only partially injected; no state
  existed. The other 13 runs passed.
- Interactive `send-keys` plus a separate Enter is removed. The smoke now
  creates a placeholder pane, writes the manifest with that pane ID, and then
  respawns it into a generated, shell-escaped launcher.
- After that correction, 20 of 20 real tmux runs passed with a 9,250-byte PATH.

## Scope

No live run, routing policy, helper permission, or installed binary was changed
by this slice. The earlier independently authorized `4c3752b` canonical deploy
was announced separately and run-101 activation remained deferred.
