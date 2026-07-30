# Verification

- `bun test` must not silently end after a partial suite.
- `bun run test:ci`
- `bun run check`
- `bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts`
- `bun run build`
- Focused redraw-smoke failure and success cleanup checks.
- Bootstrap and TERM redraw failures preserve evidence with exit 1 and 143.
- `evals/smoke/large-prompt-launch.sh`
- Twenty redraw-smoke runs pass with a PATH of at least 8 KiB.
- `git diff --check`
- `runs/test-certification-hardening/eval.json` with an empty
  `baseline_failures` list.
