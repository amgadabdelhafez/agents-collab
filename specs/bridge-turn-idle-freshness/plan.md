# Plan — Bridge Turn-Idle Freshness

## Approach

Keep the fix entirely inside the consumer, `isClaudeTurnActive`
(src/loop/bridge-runtime.ts). The hook journal already carries everything
needed: a lifecycle `state` and an ISO `ts` on every line `runHookEmit`
writes. The defect is that the consumer ignores both `failed` and age.

### Change 1 — clock seam

Add `now: () => Date.now()` to `bridgeRuntimeCommandDeps` (the module's
existing mockable dep object, alongside `spawnSync` and
`readClaudeTranscriptVersion`). `isClaudeTurnActive` reads the clock from
there; tests pin it next to fixture timestamps. No caller signature changes.

### Change 2 — state × freshness matrix

New constants (near the other `*_MS` constants):

- `CLAUDE_TURN_STARTING_STALE_MS = 30_000` — on a fresh launch the initial
  prompt paste produces `UserPromptSubmit` within a few seconds of
  `SessionStart`; a resumed session that is still `starting` after 30s is
  idling at an empty composer (defect 2). 30s matches
  `BRIDGE_DELIVERY_CLAIM_STALE_MS` in spirit: short-lived liveness windows.
- `CLAUDE_TURN_WORKING_STALE_MS = 300_000` — intra-turn hook silence is
  usually seconds (≤ ~9s observed in live run 31) but the stretch between the
  last `PostToolUse` and `Stop` covers final-response writing, which can run
  minutes. 5 minutes keeps mid-turn injection out while letting a dead
  session unblock delivery in bounded time.

Decision table for the journal tail (age = `now - Date.parse(ts)`;
missing/invalid `ts` ⇒ treat as fresh, i.e. keep today's blocking behavior):

| tail                                   | active?                        |
|----------------------------------------|--------------------------------|
| `state: "starting"`                    | age ≤ STARTING bound           |
| `state: "working"`                     | age ≤ WORKING bound            |
| `state: "failed"`                      | age ≤ WORKING bound (new)      |
| no state, event `SessionStart`         | age ≤ STARTING bound           |
| no state, event `UserPromptSubmit`/`PreToolUse`/`PostToolUse` | age ≤ WORKING bound |
| anything else (`input-required`, `Stop`, …) | false (unchanged)         |

`failed` shares the WORKING bound because an errored tool call is just a
working turn — the same "silence until next hook event" reasoning applies,
and one bound keeps the matrix small.

### Change 3 — tests (TDD, red first)

Extend tests/loop/bridge.test.ts, which today only fixtures state
`"working"`:

- unit matrix on `isClaudeTurnActive` via mocked `bridgeRuntimeCommandDeps.now`
  (fresh/stale × starting/working/failed, plus non-active states),
- delivery-level regressions: fresh `failed` blocks injection;
  stale `starting` (resume wedge) and stale `failed` deliver to an idle pane,
- pin the mock clock in the existing fresh-`working` regression so it keeps
  asserting the tail-state behavior it was written for.

## Risks

- **Bound too tight (WORKING):** would reintroduce mid-turn injection during
  long tool-free stretches. Mitigated by choosing 5 minutes, an order of
  magnitude above observed hook gaps, and by keeping pane-readiness +
  submission confirmation behind the gate.
- **Bound too loose (STARTING):** delays resume delivery by up to 30s + poll
  cadence. Acceptable: the current behavior is an indefinite wedge.
- **Clock skew:** `ts` is written by the same host that evaluates it; only
  monotonic-ish wall time is assumed, same as the delivery-claim staleness
  logic already does with `mtimeMs`.

## Touched files

- src/loop/bridge-runtime.ts (constants, deps object, `isClaudeTurnActive`)
- tests/loop/bridge.test.ts (new matrix + delivery regressions, one existing
  fixture pinned to the mock clock)
