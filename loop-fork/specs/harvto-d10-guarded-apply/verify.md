# D10 Verification

## Plan gate

Before any source, test, red-evidence, eval, staging, commit, or Harness-terminal edit, obtain Claude
literal zero-write `PLAN PASS` for exact base
`1282bd4c39ec7b3c0177810b30dab78ca6d66f41` and the SHA-256 of:

- `specs/harvto-d10-guarded-apply/spec.md`
- `specs/harvto-d10-guarded-apply/plan.md`
- `specs/harvto-d10-guarded-apply/tasks.md`
- `specs/harvto-d10-guarded-apply/verify.md`
- `runs/harvto-d10-guarded-apply/plan.md`

Required behavior 11 is an executable gate:

- Any byte change invalidates all five hashes. Freeze them together only after edits stop.
- Re-derive all five immediately before sending. The request must name exact base, all five hashes,
  require complete-file review, and require zero writes.
- Predeclare one absolute UTC deadline and a maximum of 30 `receive_messages` polls in `status.md`.
  Record every poll and result. Silence, timeout, `REVISE`, or partial/wrong identity is not pass.
- On `REVISE`, make only bounded planning corrections, re-freeze all five, and request one fresh
  full review. Two consecutive non-converging `REVISE` verdicts on the same premise stop.
- On verdict receipt, re-derive all five and recheck identical HEAD, empty index, lifecycle,
  protected evidence, utility `0/off/0`, and no source/test/red write. Proceed only if the bytes and
  literal verdict match.

## Exact-base red and RED VALID

At unchanged production bytes, add only the named regression, then run from `loop-fork/`:

```bash
bun run test:file -- tests/loop/utility-runtime.test.ts --test-name-pattern "D10 guarded apply rejects absent null-preimage target before mutation and journaling"
```

The fixture must establish one completed utility edit with matching route, claim, and current epoch;
one exact declared target absent before proposal; a valid creation-style patch; correct patch and
manifest hashes; a manifest null preimage; and otherwise valid applicability. It must use
`applyUtilityJobPatch` and reconstruct the utility job after the call. The expected contract is a
rejection naming the normalized target and expected/current absent state, target absent afterwards,
and zero `patch-applied` events. Unchanged base is red only if it instead returns `applied`, creates
the exact target, and records exactly one `patch-applied` event. Any earlier authority, hash,
manifest, scope, symlink, dependency, or patch-shape rejection is false red.

Preserve exactly `README.md`, `command.txt`, `fixture.json`, `fixture.patch`, `output.txt`, and
`SHA256SUMS` under `runs/harvto-d10-guarded-apply/artifacts/red/`. `SHA256SUMS` covers the other five
files and must validate 5/5. Capture exact HEAD and empty-index proof, production hashes, test-only
diff, target, expected/current preimages, job event order/counts, target state, command/cwd/output,
and terminal exit. Never recapture after production editing. Send one fresh Claude zero-write
review bound to exact base, frozen test diff, six files and hashes, and false-red exclusions.
Require literal `RED VALID`; recheck zero-write brackets and hashes on receipt. No production edit
before authentic bound verdict.

## Focused controls

Run from `loop-fork/`:

```bash
bun run test:file -- tests/loop/utility-tools.test.ts
bun run test:file -- tests/loop/utility-runtime.test.ts
bun run test:file -- tests/loop/utility-workspace.test.ts
bun run test:file -- tests/loop/bridge-utility.test.ts
```

Named D10 controls must prove:

- proposal creation may still capture one absent exact target with `sha256: null` without writing it;
- new application rejects expected-null/current-absent before either Git apply command, mutation, or
  application return, with exact path and `expected=absent`, `current=absent` evidence;
- removing an originally existing target after proposal reports expected digest/current absent;
- changing target bytes reports expected/current digests and exposes no contents or unrelated path;
- an exact preimage paired with a malformed or cleanly non-applicable hunk reaches
  `git apply --check`, never reaches real apply, leaves bytes exact, produces no application, and
  reports the exact target plus unchanged expected/current digests without file contents;
- the post-check preimage comparison still catches concurrent drift before real apply;
- a valid existing target applies once with exact pre/postimages, and recorded replay returns
  `already-applied`, checks postimage, creates no second mutation, and records one event total;
- D8 stale/dead actor authority rejects before broker preimage/manifest/applicability work;
- hash, manifest, target equality, exact-scope, dependency, symlink, size, workspace, bridge-utility,
  and postimage controls remain green.

Re-run the frozen named regression after implementation and require pass. Validate the frozen
`SHA256SUMS` 5/5 and compare all six file hashes with pre-implementation values; never regenerate.

## Mandatory sequence

Keep utility positively `0/off/0`. After focused controls, run from `loop-fork/`:

```bash
bun run check
bunx tsc --noEmit --skipLibCheck --types bun-types --moduleResolution bundler --module preserve --target esnext src/cli.ts src/loop/caveman-skill.d.ts
bun run build
bun run test:ci
```

Every invocation must have exact command, cwd, start/end time, terminal exit, output, and output
SHA-256 under D10 verification artifacts. A yield without a retained terminal exit is not green and
must not populate pass evals.

Only fresh green evidence may create:

- task-local `runs/harvto-d10-guarded-apply/eval.json`, with `task_id`, `status: "pass"`,
  `verdict: "pass"`, `baseline_failures: []`, required `unit`, a passing unit dimension, and a
  `run_93_verification` object binding exact base, plan and red verdict IDs/hashes, focused and
  mandatory evidence, implementation scope, and file hashes;
- repository-root `../runs/harvto-d10-guarded-apply/eval.json`, with `task_id`, `verdict: "pass"`,
  `baseline_failures: []`, summary/checks, and a matching `run_93_verification` object.

Neither eval may contain any by-name baseline allowlist entry. From repository root, validate both:

```bash
python3 scripts/check-baseline-allowlist.py loop-fork/runs/harvto-d10-guarded-apply/eval.json
python3 scripts/check-baseline-allowlist.py runs/harvto-d10-guarded-apply/eval.json
```

Then from `loop-fork/`:

```bash
./harness preflight --json
./harness stop-gate --json
```

Finally from repository root:

```bash
./scripts/verify.sh harvto-d10-guarded-apply harvto-d10-guarded-apply
```

The root verifier is a sealing repeat. Any failure, skip, stale output, nonempty baseline, scope
drift, or missing terminal exit makes both provisional evals honest fail records and stops before
review, commit, or close.

## Scope, review, close, and bookkeeping

- Implementation paths are exactly `loop-fork/src/loop/utility-tools.ts`,
  `loop-fork/tests/loop/utility-tools.test.ts`, and
  `loop-fork/tests/loop/utility-runtime.test.ts`. All other source/test paths are read-only. Any
  source or test expansion requires five-file contract revision and a fresh `PLAN PASS` before edit.
- Compare normal and ignore-all-space numstats over exactly those three paths. Stage each full path
  individually; inspect the full cached diff and require `git diff --cached --check`.
- Exclude contracts, red/evals, Harness lifecycle, root ledgers, root `.loop/`, frozen D6-D9 red,
  formatter evidence, D11/D12, Harvto, dependencies, remotes, and release/deploy paths from the
  implementation commit.
- Obtain Claude literal zero-write `PASS` naming the exact implementation SHA, parent/base, three
  paths and hashes, five contract hashes, frozen red and `RED VALID`, focused/mandatory evidence,
  both eval hashes, empty allowlists, verifier, preserved state, and utility `0/off/0`.
- Only exact-SHA `PASS` permits one `./harness done harvto-d10-guarded-apply`; never retry. Prove D10
  alone becomes `done/pass`, exactly one terminal row exists, current-task clears, and every non-D10
  task/parked/evidence hash remains exact.
- Commit only an explicit bookkeeping manifest of D10 contracts, red/evals/non-red evidence,
  expected lifecycle outputs, close evidence, and individually named root ledgers. Keep
  implementation paths and all unrelated/preserved state out. No amend.
- Obtain Claude literal zero-write `BOOKKEEPING PASS` for the exact bookkeeping commit SHA, path/blob
  manifest, lifecycle isolation, implementation `PASS`, clean index, preserved dirty scope, and
  utility `0/off/0`. Only then request governed handover. Validate two same-epoch ready bundles,
  then teardown. D11/D12 stay parked and are not promoted.
