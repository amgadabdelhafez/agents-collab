# Test commands

## Focused unit tests

```bash
cd loop-fork
bun run test:file -- tests/loop/<module>.test.ts
```

The producer-backed worktree cleanup regression is:

```bash
cd loop-fork
bun run test:file -- tests/worktree-reaper.test.ts
```

## Integration test

```bash
cd loop-fork
bun run test:file -- tests/loop/00-paired-loop.integration.test.ts
```

## Repository checks

```bash
cd loop-fork
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

`bun run test:ci` deliberately runs each test file in sorted order. This catches
module-state leaks and lifecycle bugs that an isolated focused test can miss.
Direct `bun test` is intentionally rejected before any assertion runs because
the current Bun canary does not expose the original selector set to preloads and
has intermittently terminated the shared-process suite with exit 133. Use
`bun run test:file -- <file>` for one file or `bun run test:ci` for complete
certification.

Both scripts run each file under `loop-fork/scripts/test-hermetic.sh`, which
gives it a fresh scratch `HOME` and `TMUX_TMPDIR` and unsets `TMUX`,
`TMUX_PANE` and `LOOP_TMUX_SOCKET`, so no test reads the live `~/.loop/runs`
or reaches a live tmux server. `tests/setup.ts` refuses any other launch:
Bun fixes `os.homedir()` and the environment `Bun.spawn` gives children at
startup, so only the launch environment can isolate them. The docker CLI's
current context also lives under `HOME` (colima's socket), so the launcher
resolves its endpoint before the swap and passes it on as `DOCKER_HOST` (an
explicit `DOCKER_HOST` is kept); the Docker-backed Postgres suites need it.

## Full task verification

```bash
scripts/verify.sh <feature> <task-id>
```

Both arguments are required. The task must already have a passing
`runs/<task-id>/eval.json` with an empty `baseline_failures` list. The verifier
runs lint, typecheck, build, the complete sequential test suite, and the
baseline gate. Missing task identity and legacy count/status allowances fail
closed.

## UI capture

```bash
scripts/capture-ui.sh --out runs/<task-id>/screenshots/
```

UI capture is required only for tasks that change rendered UI behavior.
