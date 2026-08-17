# D9 Verification

## Plan gate

Before any source, test, red-evidence, eval, staging, commit, or Harness-terminal edit, obtain
Claude literal zero-write `PLAN PASS` for exact base
`18a590608b335f6a7637bf8215c4fe0508301282` and the SHA-256 of:

- `specs/harvto-d9-duplicate-emission/spec.md`
- `specs/harvto-d9-duplicate-emission/plan.md`
- `specs/harvto-d9-duplicate-emission/tasks.md`
- `specs/harvto-d9-duplicate-emission/verify.md`
- `runs/harvto-d9-duplicate-emission/plan.md`

Required behavior 10 is an executable gate:

- Any byte change invalidates all five hashes. Freeze them together only after edits stop.
- Re-derive all five immediately before sending. The request must name the exact base, include all
  five hashes, require complete-file review, and state that Claude must perform zero writes.
- `REVISE`, partial/wrong identity, silence, or post-request edits void the set. Apply only bounded
  planning corrections, re-freeze all five, and request a fresh full review. Two consecutive
  non-converging `REVISE` verdicts on the same premise stop and escalate.
- On verdict receipt, re-derive all five. Proceed only if the bytes still match and the verdict is
  literal `PLAN PASS` naming the exact base and all five hashes.

## Exact-base red

At unchanged production bytes, add only the named regression, then run from `loop-fork/`:

```bash
bun run test:file -- tests/loop/governess-p0-runtime.test.ts --test-name-pattern "D9 resolved acknowledgement emits once across supersession retry and replay"
```

The fixture must use four pending codex-to-supervisor predecessor messages with the four Run197
dedupe keys. It then submits the same explicit resolved ack body/subject four times with
`supersede: true`, reconstructs events and pending state from the real append-only file, consumes
the supervisor inbox, and retries after delivery. It must assert four predecessor supersessions,
one ack message/transcript/delivery identity, and no post-delivery append. Unchanged base is red
because it creates four ack message rows, four transcript emissions, four pending/delivered IDs,
and four `queued` results.

Preserve exactly `README.md`, `command.txt`, `fixture.json`, `fixture.patch`, `output.txt`, and
`SHA256SUMS` under `runs/harvto-d9-duplicate-emission/artifacts/red/`. `SHA256SUMS` covers the other
five files and must validate 5/5. Capture exact HEAD, empty-index proof, production hash, Run197
journal/transcript hashes, test diff, four attempt results, message/supersession/delivery event
IDs/order, transcript counts, exit code, and output. Never recapture after production editing. A
test that bypasses `enqueueBridgeMessage`, append/re-read, transcript, or consume is invalid. If
base does not create four effective emissions for the declared fixture, record `not-reproduced` and
stop without implementation.

## Focused controls

```bash
bun run test:file -- tests/loop/governess-p0-runtime.test.ts
bun run test:file -- tests/loop/bridge.test.ts
bun run test:file -- tests/loop/paired-loop.test.ts
bun run test:file -- tests/loop/00-paired-loop.integration.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
```

Named D9 controls must prove:

- the Run197 four-key sequence yields one canonical ack ID, one ack message row, one transcript
  emission, and one delivered resolution while all four predecessor rows are superseded once;
- attempt statuses are one `queued` followed by three `duplicate`, all returning the same canonical
  row; replay after reconstructed restart and after delivery appends nothing;
- a crash fixture with predecessor superseded but no ack permits one later append, while an existing
  ack message row is already a durable fence before notification or delivery;
- same-key `supersede: true` replay returns its pending canonical ack without superseding it;
- changing source, target, body, subject, reply/task/thread correlation, or ordered artifact list
  creates a distinct ack, and those unrelated messages remain consumable;
- repeated same-body non-ack messages remain independent under the existing test contract;
- old explicit ack rows with missing optional metadata fence equivalent retries, while untyped
  legacy rows remain ordinary messages and malformed rows retain current behavior;
- D1 liveness/TTL/pressure/supersession, D4 peer reconciliation, D5 completion replay, MCP
  send/receive, queue ordering, and transcript behavior remain green;
- no fixture mutates live Run89, imported Run197, root `.loop/`, frozen red, or external Harvto.

## Mandatory sequence

Keep utility positively `0/off/0`. Run focused controls first, then from `loop-fork/`:

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

Only actual green results may produce pass evals. Write task-local
`runs/harvto-d9-duplicate-emission/eval.json` and repository-root
`../runs/harvto-d9-duplicate-emission/eval.json` with `baseline_failures: []` and empty by-name
allowlists. From repository root, validate both:

```bash
python3 scripts/check-baseline-allowlist.py loop-fork/runs/harvto-d9-duplicate-emission/eval.json
python3 scripts/check-baseline-allowlist.py runs/harvto-d9-duplicate-emission/eval.json
```

Then from `loop-fork/`:

```bash
./harness preflight --json
./harness stop-gate --json
```

Finally from repository root:

```bash
./scripts/verify.sh harvto-d9-duplicate-emission harvto-d9-duplicate-emission
```

The root verifier is a sealing repeat. Every focused and mandatory invocation must have captured
command, cwd, terminal exit, output, and SHA-256 under the D9 run artifacts. Any failure, skip,
yield without terminal exit, stale result, or non-empty baseline makes both provisional evals honest
fail records and stops before review, commit, or close. No UI capture is required.

## Scope, review, close, and bookkeeping

- Implementation paths are exactly `loop-fork/src/loop/bridge-store.ts` and
  `loop-fork/tests/loop/governess-p0-runtime.test.ts`.
- Compare normal and ignore-all-space numstats over exactly those paths. Stage no other
  implementation path; inspect the full cached diff and require `git diff --cached --check`.
- Exclude contracts, red evidence, evals, Harness lifecycle, root ledgers, root `.loop/`, frozen
  D6/D7/D8 evidence, Run197, formatter evidence, D10-D12, Harvto, dependencies, remotes, and
  release/deploy paths from the implementation commit.
- Obtain Claude literal zero-write `PASS` naming the exact implementation commit SHA, parent, two
  paths and hashes, frozen red, focused/mandatory evidence, both eval hashes, and empty allowlists.
- Only exact-SHA `PASS` permits one `./harness done harvto-d9-duplicate-emission`. Never retry.
  Prove D9 alone becomes `done/pass`, exactly one terminal record exists, current-task clears, and
  every non-D9 task/parked hash remains exact.
- Commit D9 contracts, lifecycle, evals, non-red evidence, and required ledgers separately. Preserve
  immutable red unmodified and exclude it if its provenance whitespace cannot pass commit checks.
  Obtain Claude literal zero-write `BOOKKEEPING PASS` for the exact bookkeeping SHA and clean
  index/tracked tree before governed handover.
