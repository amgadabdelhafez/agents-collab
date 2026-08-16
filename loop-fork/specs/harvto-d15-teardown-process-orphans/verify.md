# D15 Verification

## Exact-base red

At unchanged production base `fb71f47bb126a39eae7f1613fa952c994421de5e`, run the named
regression `D15 teardown proves exact owned launcher and Claude PIDs absent while preserving an
unowned process`. Preserve the command, exit code, fixture run directory shape, ownership records,
before/after direct PID probes, signaled PIDs, cleanup result, and decisive assertion under
`runs/harvto-d15-teardown-process-orphans/artifacts/red/`.

Do not recapture the red. Before making it a green acceptance test, await each owned child's `exit`
event deterministically before the post-cleanup assertion. Positive pre-liveness remains required;
post-cleanup success means no PID after reaping, while production settlement separately accepts
exact `ps stat` state `Z`/defunct for a child whose parent intentionally has not reaped it.

## Focused controls

```bash
bun run test:file -- tests/loop/run-process-cleanup.test.ts
bun run test:file -- tests/loop/governess-exit.test.ts
bun run test:file -- tests/loop/governess-hooks.test.ts
bun run test:file -- tests/loop/tmux.test.ts
bun run test:file -- tests/loop/run-state.test.ts
```

Named controls must cover positive pre-liveness, direct post-absence, TERM success, KILL escalation,
survival/unresolved receipt, PID identity change, registration failure, replay-safe retry, exact
run isolation, unowned PID preservation, cleanup exception, and live/unknown tmux handling.

The following controls are mandatory and named:

- `D15 zombie target is settled after TERM while its parent has not reaped it`: hold an exited child
  as `Z`/defunct, prove `kill(pid,0)` and `ps -p` still report it, and require cleanup to report it
  settled rather than unresolved without sending KILL to a changed identity.
- `D15 cleanup never signals itself or an ancestor`: inject exact self/ancestor PPID evidence,
  require zero signals, retain non-launcher/ancestor ownership, and require durable
  `unresolved:self-or-ancestor`.
- `D15 native-child SessionStart creates no agent ownership record`: pair it with a main-agent
  SessionStart positive control and rerun all hook-setting event compatibility assertions after the
  global `exec` process-shape change.
- `D15 ordinary teardown transfers only its exact self launcher and reaches stopped`: require the
  active self-launcher record to be removed only after a versioned deferred receipt is durable,
  require no inline unresolved ownership, directly settle every other process and the exact tmux
  target, and assert lifecycle `stopped`, not `failed`. A non-launcher self or any ancestor remains
  ineligible and must take the failed/unresolved branch.
- `D15 abandoned-run GC treats a zombie manifest launcher as settled`: hold the manifest PID in
  `Z`/defunct state, prove bare `kill(pid,0)` still reports it, and require abandoned-run
  classification plus deferred-receipt cleanup to use the shared zombie-aware predicate.

Additional controls must prove exact command plus one-second `lstart` behavior, including its
documented same-second/identical-command bound; exact launch-recorded tmux socket and session death;
missing or unknown socket failure without default-socket fallback; and strict enumeration under only
the fixture's temporary `runDir`, with preserved live runs never inspected or signaled. Every PID
liveness consumer in `run-process-cleanup.ts`, including `runIsProvablyAbandoned`, must be exercised
through the shared zombie-aware settled predicate rather than a teardown-only special case.

## Mandatory suite

Run from `loop-fork/` with utility fixed at `0/off/0`:

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
LOOP_TEST_CERTIFICATION_MODE=single-file bun run test:ci
./harness preflight --json
./harness stop-gate --json
```

Write passing Harness and repository-root evals with `baseline_failures: []`, then run from the
repository root:

```bash
./scripts/verify.sh harvto-d15-teardown-process-orphans harvto-d15-teardown-process-orphans
```

No UI capture is required because D15 changes no rendered UI.

## Scope and review

- Compare normal and ignore-all-space numstats and require equality.
- Stage explicit D15 paths only; exclude root `.loop/`, unrelated tasks, Harvto, dependencies,
  provider/model configuration, remote/deployment/release paths, and lifecycle bookkeeping.
- Obtain Claude zero-write literal `PASS` for the exact implementation SHA before one Harness
  close and separate bookkeeping commit.
