# D15 Exact-Base Red Reproduction

Base production SHA: `fb71f47bb126a39eae7f1613fa952c994421de5e`

Production was unchanged. The only behavior edit was the named regression in
`tests/loop/run-process-cleanup.test.ts`.

## Fixture

The isolated temporary run directory contained a `run-processes/` registry with two proposed
schema-v1 exact-identity records:

- `owned-launcher-43762.json`: `kind=run-owned`, `role=launcher`, PID 43762, exact `ps command`,
  exact `ps lstart`, and exact temporary `runDir`.
- `owned-agent-claude-43763.json`: the same identity fields with `role=agent` and `agent=claude`.

PID 43764 was an intentionally unregistered control. All three were fixture-owned Bun interval
children and were directly live before teardown. The fixture `finally` block sent `SIGKILL` only
to any surviving fixture children and removed the temporary directory.

## Command

```bash
export LOOP_UTILITY_ENABLED=0
export LOOP_UTILITY_DELEGATION_MODE=off
export LOOP_AU_PAIR_ENABLED=0
export LOOP_TEST_CERTIFICATION_MODE=single-file
bun test tests/loop/run-process-cleanup.test.ts -t "D15 teardown proves exact owned launcher and Claude PIDs absent while preserving an unowned process"
```

Exit code: `1`.

## Decisive result

```text
aliveBefore: expected [true, true, true], observed [true, true, true]
aliveAfter:  expected [false, false, true], observed [true, true, true]
killed:      expected [43762, 43763], observed []
0 pass, 16 filtered out, 1 fail, 2 expect() calls
```

The current cleanup ignores both launcher and Claude ownership records, leaves both owned PIDs
alive, and correctly does not touch the unowned control only by omission. A direct post-fixture
`ps -p 43762,43763,43764` returned no rows, confirming the fixture cleanup left no orphan.
