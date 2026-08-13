# D4 Baseline Reproduction

## Identity

- Canonical task: `harvto-d4-live-peer-unconsumed`
- Unchanged production base: `0822c3546c44521ea778324d66d6c4c98f3972fb`
- Only test diff before run: `tests/loop/utility-runtime.test.ts`
- Production diffs before run: none

## Command

```bash
cd loop-fork
bun run test:file -- tests/loop/utility-runtime.test.ts
```

Exit: `1`. Existing file controls: `52 pass`; D4 regression: `1 fail`.

## Named regression

`D4 live peer consumption and correlated response terminalize routed-peer once across replay`

This historical red proof was later renamed, with strict-superset assertions preserved, to
`D4 peer instruction requires decision while ack and untyped replies stay nonterminal across replay`.

The test proves exact Claude target liveness independently with injected manifest mapping
`tmuxPaneRightAgent: "claude"`, pane `%9`, session `d4-live-session`, and positive pane evidence.
No real tmux, provider, network call, or sleep is used.

## Durable sequence before decisive failure

Utility journal assertions passed:

```text
route-requested:pending-route
state-transition:routed-peer
```

Bridge journal sequence assertions passed:

```text
message:codex:claude      type=review_request taskId=d4-live-peer-job
message:utility:supervisor type=work_request taskId=unrelated-d4-control
delivered:codex:claude    reason="D4 exact peer consumed routed review"
message:claude:codex      type=decision taskId=d4-live-peer-job replyTo=<review request id>
```

The unrelated supervisor message remained untouched.

## Decisive failure

After one further `processPendingUtilityRoutes` reconciliation, expected:

```text
state=completed
result.status=completed
result.summary="PASS: docs-only commit abc123 is banked."
```

Actual snapshot remained:

```text
state=routed-peer
result=undefined
events=[route-requested:pending-route, state-transition:routed-peer]
```

Failure occurred at `tests/loop/utility-runtime.test.ts:1382` with
`expect(received).toMatchObject(expected)`. This proves exact live-peer consumption and a correlated
response have no owner that transitions the durable utility job out of `routed-peer`.

## Controls

- Exact target, source, task ID, request type, response type, and `replyTo` are asserted.
- Positive liveness is separate from bridge delivery and peer consumption.
- Existing peer routing test passed.
- Existing routed-driver/requester, stale-worker, epoch fencing, helper completion, and replay
  controls in the same file passed.
- Replay/no-duplicate assertions are after the missing terminal transition and therefore remain red
  until the reproduced branch is fixed.
