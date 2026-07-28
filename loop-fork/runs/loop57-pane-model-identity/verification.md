# Verification

- `./harness verify unit -- bun test tests/loop/utility-observability.test.ts tests/loop/utility-runtime.test.ts tests/loop/utility-tools.test.ts`
  passed: 87 tests.
- `./harness verify full -- bun run test:ci` passed: 1,105 tests across 55
  files.
- `./harness verify build -- bun run build` passed. Compiled binary SHA-256:
  `3128203cb48b0d2d5729ee21caebbd140d9d877d77cbf844c481c01a1a60a3db`.
- `git diff --check` passed.
- Live Nanny pane `%4` contains only `QWEN` request/tool/result lines and no
  Governess project summary or advisory.
- Live Au Pair pane `%3` contains only `GLM` request/tool/result lines.
- The pane-border titles remain role-based; the body labels are model-based.
- Full model/version details appear only in Governess; each job ID appears once
  and the body shows the real objective and result summary.
- Claude `%0` PID `70452` and Codex `%1` PID `70454` were not restarted.
- The broker regression explicitly confirms `lstat` sees a symlinked declared
  scope root and no missing-path candidate crosses it.
