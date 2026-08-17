# D6 Verification

## Plan gate

Before any source or test edit, obtain Claude literal zero-write `PLAN PASS` for the exact base,
canonical paths and hashes, two-file implementation boundary, red fixture, named controls, D11
exclusion, and mandatory commands. Any `REVISE` updates planning only and requires fresh hashes and
review.

## Exact-base red

At unchanged production base `ee1e7736d876d4b387f13580ec25ddf1c606e873`, run only the named
regression:

```bash
bun run test:file -- tests/loop/tmux.test.ts --test-name-pattern "D6 read-only target-window client does not block Claude suggested-composer recovery"
```

The fixture owns all state and performs no live tmux or Harvto mutation. Preserve the command, exit
code, exact pane/session/window identity, pane snapshot, read-only client record, emitted tmux
queries, key calls, and decisive assertion under
`runs/harvto-d6-readonly-attach/artifacts/red/`. The expected base failure is zero probe keys where
one acknowledged bounded probe is required. Remove no assertion and never overwrite this evidence.

If the test does not fail for the blanket `activeClients` gate, stop the implementation branch and
record `not-reproduced`.

## Focused controls

```bash
bun run test:file -- tests/loop/tmux.test.ts
```

Named D6 controls must prove:

- one or more positively identified read-only clients viewing the exact target window permit the
  otherwise-safe suggested-composer probe;
- a stable positively read-only target-window set present across the whole probe returns
  `candidate-changed`, not `ClaudePostProbeIndeterminateError`, when the suggestion text changes
  after the bounded send;
- any writable target-window client permits zero keys;
- pane-bound `window_active_clients_list` identities exactly match the relevant identities from
  session-bound `list-clients`; count equality is asserted only as a cross-check and cannot make a
  wrong identity set safe;
- failed, timed-out, absent, duplicate, malformed, extra-fixed-marker-arity, count-mismatched,
  wrong-target, missing-intersection, and unsupported client evidence permits zero keys;
- a client identity or read-only mode change across the mutation boundary permits zero keys;
- writable clients on another window do not taint the exact target, while target-window membership
  is never inferred from a server-wide count;
- zero active clients are safe only with explicit empty pane-identity and matched-mode sets; a
  positive count with either set absent/empty is unsafe, and the synthetic `capturePane` shim emits
  the explicit zero/empty/empty state;
- pane pipes, human drafts, cursor/activity changes, and unclassifiable post-send state retain their
  existing fail-closed behavior;
- replay after an acknowledged empty composer sends no duplicate probe or submission.

The tests use deterministic injected tmux outputs only. They never attach to, send keys to, or
inspect a preserved live run. They must assert the exact default query construction, including the
pane-bound client-identity field and session-bound `client_readonly` records. This does not certify
deployed tmux output; the documented compatibility bound is the local tmux 3.7b manual, and any
unsupported live output must take the zero-key fail-closed branch.

## Mandatory suite

Run from `loop-fork/` with utility positively fixed at `0/off/0`:

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
./scripts/verify.sh harvto-d6-readonly-attach harvto-d6-readonly-attach
```

No UI capture is required because D6 changes no rendered UI.

## Scope and review

- Compare normal and ignore-all-space numstats and require equality.
- The implementation commit contains only `loop-fork/src/loop/tmux.ts` and
  `loop-fork/tests/loop/tmux.test.ts`.
- Exclude canonical/run planning, red evidence, evals, Harness lifecycle, matrix/status/PLAN,
  root `.loop/`, other defects, Harvto, dependencies, provider/model configuration, remotes, and
  deployment/release paths from the implementation commit.
- Obtain Claude zero-write literal `PASS` for the exact implementation SHA before one Harness close
  and separate bookkeeping commit.
