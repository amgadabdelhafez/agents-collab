# D8 Verification

## Plan gate

Before any source, test, red-evidence, eval, or Harness-terminal edit, obtain Claude literal
zero-write `PLAN PASS` for exact base
`66fd1e13745832cfb959e9fb1b3fb295f2ba5ee9` and the SHA-256 of:

- `specs/harvto-d8-stale-write-lease/spec.md`
- `specs/harvto-d8-stale-write-lease/plan.md`
- `specs/harvto-d8-stale-write-lease/tasks.md`
- `specs/harvto-d8-stale-write-lease/verify.md`
- `runs/harvto-d8-stale-write-lease/plan.md`

Required behavior 12 is an executable gate:

- Any byte change invalidates all five hashes. Freeze them together only after edits stop.
- Re-derive all five immediately before sending and require equality. The request must be one fresh
  zero-write review of all five complete files at the exact base. Root-plan decision
  `9614efc7-e967-497e-89f7-578af88460ed` is not this gate and consumes no D8 review cycle.
- `REVISE`, partial/wrong identity, silence, or post-request planning edits void the set. Apply only
  bounded planning corrections, re-freeze all five, and request another full review. Two
  consecutive `REVISE` verdicts on the same premise stop and escalate.
- On verdict receipt, re-derive all five. Proceed only if bytes still match and the verdict is
  literal `PLAN PASS` naming exact base and all five hashes.

## Exact-base red

At unchanged production bytes, add only the named test, then run from `loop-fork/`:

```bash
bun run test:file -- tests/loop/utility-runtime.test.ts --test-name-pattern "D8 stale utility write authority rejects before two-file mutation"
```

The fixture creates two present byte-valid files and one aggregate patch whose manifest, targets,
preimages, and Git applicability remain valid. It routes and claims at epoch 30, completes the
proposal, then changes only the current active epoch to 31 before calling
`applyUtilityJobPatch`. The expected contract is rejection. The decisive unchanged-base failure is
that the call resolves `applied` and both files contain their proposed postimages. A failure caused
by changed fixture bytes, target absence, manifest drift, or non-applicability is D10 behavior, a
false D8 pass, and must be recorded `not-reproduced`.

Preserve exactly `README.md`, `command.txt`, `fixture.json`, `fixture.patch`, `output.txt`,
and `SHA256SUMS` under `runs/harvto-d8-stale-write-lease/artifacts/red/`.
`SHA256SUMS` covers the other five files and must validate 5/5. Capture exact HEAD, empty-index
proof, production hashes, route/claim/current epochs, file pre/post hashes, event types, exit, and
the test diff. Never recapture after production editing.

## Focused controls

```bash
bun run test:file -- tests/loop/utility-store.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-tools.test.ts
bun run test:file -- tests/loop/utility-workspace.test.ts
bun run test:file -- tests/loop/bridge-utility.test.ts
```

Named D8 controls must prove:

- current epoch, route epoch, and claim epoch are positive and equal before apply;
- missing claim, changed epoch, or route/claim mismatch rejects before broker apply;
- activation and mutation cannot cross the same authority critical section;
- the section uses an awaited lock whose owner remains held/non-stale through the mutation callback;
  passing the Promise through synchronous `withStoreLock` must fail the control;
- in-section application journaling calls internal `recordUtilityPatchApplicationLocked` without
  trying to reacquire the non-reentrant lock;
- contended `activateUtilityEpoch` cannot run before mutation completes and cannot return `false`
  for lock contention: it either acquires after release and advances, or throws
  `utility store is busy` when the existing acquisition deadline expires;
- after contention clears, `activateUtilityEpoch` advances normally; `false` remains evidence of
  an already-newer epoch only;
- every negative case leaves both files byte-identical and has zero `patch-applied` events;
- matching authority applies both valid files once and journals once;
- same-authority replay returns `already-applied`, makes no second mutation, and retains one event;
- completed worker PID liveness is not required;
- existing manifest/hash/scope/two-preimage/applicability/postimage and linked-worktree controls pass;
- bridge application remains restricted to a full in-loop agent;
- no fixture mutates live Run87, root `.loop/`, frozen red, or external Harvto.

## Mandatory sequence

Keep utility positively `0/off/0`. Run focused controls first, then from `loop-fork/`:

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

Only actual green results may produce pass evals. Write task-local
`runs/harvto-d8-stale-write-lease/eval.json` and repository-root
`../runs/harvto-d8-stale-write-lease/eval.json` with `baseline_failures: []` and empty by-name
allowlists. From repository root, validate both:

```bash
python3 scripts/check-baseline-allowlist.py loop-fork/runs/harvto-d8-stale-write-lease/eval.json
python3 scripts/check-baseline-allowlist.py runs/harvto-d8-stale-write-lease/eval.json
```

Then from `loop-fork/`:

```bash
./harness preflight --json
./harness stop-gate --json
```

Finally from repository root:

```bash
./scripts/verify.sh harvto-d8-stale-write-lease harvto-d8-stale-write-lease
```

The root verifier is a sealing repeat. Any focused, mandatory, baseline, Harness, or repeat failure
makes both provisional evals honest fail records and stops before review, commit, or close. No
silent or skipped command is green. No UI capture is required.

## Scope and review

- Implementation paths are exactly
  `loop-fork/src/loop/utility-store.ts`,
  `loop-fork/src/loop/utility-runtime.ts`,
  `loop-fork/tests/loop/utility-store.test.ts`, and
  `loop-fork/tests/loop/utility-runtime.test.ts`.
- Compare normal and ignore-all-space numstats over exactly those paths; whole-file additions are
  classified separately. Stage no other implementation path and run `git diff --cached --check`.
- Exclude plans, red evidence, evals, Harness lifecycle, root ledgers, root `.loop/`, frozen
  D6/D7 evidence, other defects, Harvto, dependencies, remotes, and release/deploy paths from the
  implementation commit.
- Obtain Claude literal zero-write `PASS` naming the exact implementation commit SHA before one
  Harness close and separate bookkeeping commit.
