# D3 Exact-Base Reproduction

## Result

D3 reproduced on unchanged production base
`d5d3140844f9ff7f8447156f4b4f7f27ac093d96`.

The named regression starts a Governess with one exact current driver and no routing peer, after
durably appending one bounded utility request. Two bounded Governess cycles and clean test teardown
leave the job silently `pending-route` with no decision or result.

## Production precondition

```text
git rev-parse HEAD
d5d3140844f9ff7f8447156f4b4f7f27ac093d96

git diff --name-only -- loop-fork/src
<empty>
```

Only the named regression and task planning/evidence existed outside production during this run.

## Command

```bash
cd loop-fork
bun run test:file -- tests/loop/governess.test.ts -t "D3 Governess fails closed once when pending utility work has no routing peer"
```

Result: 0 pass, 1 fail, exit 1.

Decisive assertion:

```text
Expected state: escalated
Expected decision: { reason: "routing-owner-unavailable", target: "escalate" }
Received state: pending-route
Received decision: undefined
```

## Durable journal evidence

Reconstructed job contains exactly one event:

```text
route-requested:pending-route
```

Snapshot evidence:

```text
state: pending-route
decision: undefined
result: undefined
routeEpoch: undefined
```

No `route-decided`, decision-bearing state transition, worker start, bridge dispatch, or terminal
result exists. Governess skipped `processPendingUtilityRoutes` because `utilityPeer` was absent.

## Control boundary

Existing `utility-runtime.test.ts` already proves a full but eligible pool may leave work pending
and later routes it once capacity frees. D3 must preserve that behavior. Existing no-tier tests
prove `processPendingUtilityRoutes` records `utility-unavailable` when it is invoked; this
reproduction isolates the missing invocation/ownership branch.

## Failed test-harness path

The first test-only attempt used an immediately resolved sleep, allowing the tick promise to win
continuously over exit-key handling. Exact spawned test PIDs were terminated, the test sleep was
changed to the existing 5 ms deterministic pattern, and the rerun produced the decisive red result
above. No production or preserved run process was signaled.
