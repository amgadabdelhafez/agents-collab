# D7 Verification

## Plan gate

Before any source, test, red-evidence, eval, or Harness-terminal edit, obtain Claude literal
zero-write `PLAN PASS` for exact base `2c415e124c4cb2b39d81fa19a8e977e50dba48a9` and the
SHA-256 of these five files:

- `specs/harvto-d7-handoff-identity/spec.md`
- `specs/harvto-d7-handoff-identity/plan.md`
- `specs/harvto-d7-handoff-identity/tasks.md`
- `specs/harvto-d7-handoff-identity/verify.md`
- `runs/harvto-d7-handoff-identity/plan.md`

The review must cover the fresh-run lineage interpretation, exact ten-file implementation scope,
deterministic red, controls, exclusions, and mandatory commands. Any `REVISE` updates planning
only, freezes fresh hashes, and requires a new review. Literal `PLAN PASS` is the sole authority to
begin the regression.

Required behavior 11 is an enforced gate, not advisory wording:

- Every byte change to any listed planning file invalidates the complete five-hash set. Compute all
  five SHA-256 values together only after every planning edit stops.
- Immediately before sending, re-derive all five and require exact equality with the recorded set.
  Submit one fresh zero-write review of all five complete files at the exact base; prior acceptance
  of unchanged sections and delta-only review are invalid substitutes.
- A `REVISE`, partial verdict, wrong base or hash, silence, or any post-request planning edit voids
  the request. Apply bounded planning corrections only, then re-freeze all five and request another
  full review. Two consecutive `REVISE` verdicts on the same premise without convergence stop and
  escalate to the supervisor rather than triggering a third re-freeze.
- On verdict receipt, re-derive all five again. Proceed only when the bytes still match and the
  verdict is literal `PLAN PASS` naming exact base
  `2c415e124c4cb2b39d81fa19a8e977e50dba48a9` plus all five current SHA-256 values. Any inequality
  blocks source/test edits and red capture.

## Exact-base red

At unchanged production base, add the named test only, then run:

```bash
bun run test:file -- tests/loop/governess-exit.test.ts --test-name-pattern "D7 governed handoff preserves exact effective launch identity"
```

The fixture supplies source run/repo/workspace/topology identity, Codex
`gpt-5.6-sol` at high effort, a Claude `opus` peer, and hostile ambient Codex
`gpt-5.6-luna`/low defaults. It obtains replacement argv from `replacementLoopArgs`, passes that
argv through the real parser into `Options`, and then calls existing base-reachable
`tmuxInternals.buildPairedAgentCommand`. The decisive expected base failure reads the resolved
effective Codex model from that function's returned launch argv: actual `gpt-5.6-luna` versus
expected source `gpt-5.6-sol`. A direct assertion that replacement argv omits
`--codex-model gpt-5.6-sol` may document mechanism but cannot be the decisive red. The fixture
performs no spawn, provider call, live tmux operation, external repo write, production export, or
resolver extraction. No `src/` byte may change before this red is captured; shared resolver work
begins only after the frozen red exists.

Preserve the command, exact fixture, output, exit code, replacement argv, parsed `Options`, returned
launch argv, resolved effective model, ambient values, decisive assertion, HEAD, index proof, and
pre/post production hashes under `runs/harvto-d7-handoff-identity/artifacts/red/`. Never modify or
recapture those files after production editing. If the failure is not the end-to-end
hostile-default resolution branch through `tmuxInternals.buildPairedAgentCommand`, record
`not-reproduced` and stop.

## Focused controls

```bash
bun run test:file -- tests/loop/run-state.test.ts
bun run test:file -- tests/loop/paired-options.test.ts
bun run test:file -- tests/loop/governess-runtime.test.ts
bun run test:file -- tests/loop/governess-exit.test.ts
```

Named D7 controls must prove:

- run manifests round-trip the exact per-agent effective models and normalized handoff lineage;
  malformed or partial identity is rejected for handoff authority without making all legacy
  manifests unreadable; the shared normalized launch-identity type is declared and exported from
  `src/loop/run-state.ts`, with no `src/loop/types.ts` scope expansion;
- the same effective-model resolver supplies tmux commands and persisted identity, including
  reviewer overrides and literal `auto` values;
- live-pane resume restores persisted agent/model/effort roles, while an explicit conflicting
  selection fails before relabeling or launch;
- replacement argv maps Codex, Gemini, Copilot, Cursor, and Claude-reviewer model flags to the
  frozen primary/reviewer roles and preserves asymmetric efforts; a Claude-primary value the
  parent can prove inexpressible under its own CLI/default contract fails before spawn;
- replacement-side pre-acceptance identity comparison rejects drift caused by a replacement binary
  with a different compiled Claude-primary default, and the parent performs no mark/kill effect;
- the handoff digest covers source run/repo, normalized workspace root/repo/branch, source manifest
  identity, topology, models, efforts, bundles, continuation, and transaction epoch; changing any
  one makes read or acceptance fail;
- a valid handoff creates a different replacement run ID while persisting exact source lineage and
  the same workspace/launch identity;
- acceptance binds the exact replacement run/repo/manifest identity, session, and newer epoch;
  missing legacy identity or any model, effort, topology, workspace, lineage, digest, session, or
  epoch mismatch yields no acceptance;
- launch failure, dead/unready replacement, malformed acceptance, and every identity mismatch leave
  old-run mark/kill calls at zero;
- a Governess restart retains the original handoff transaction identity, and repeated acceptance or
  control replay cannot launch, mark, kill, or accept twice;
- all tests are temporary/injected and leave run-83 state, the inert old-epoch file, root `.loop/`,
  and the external Harvto repository byte-preserved.

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

Write passing Harness and repository-root evals with `baseline_failures: []` and verify the by-name
allowlist is empty, then run from the repository root:

```bash
./scripts/verify.sh harvto-d7-handoff-identity harvto-d7-handoff-identity
```

No UI capture is required because D7 changes no rendered UI.

## Scope and review

- Compare normal and ignore-all-space numstats and require equality.
- The implementation commit contains only:
  `loop-fork/src/loop/tmux.ts`, `loop-fork/src/loop/run-state.ts`,
  `loop-fork/src/loop/paired-options.ts`, `loop-fork/src/loop/governess-handoff.ts`,
  `loop-fork/src/loop/governess-exit.ts`, `loop-fork/src/loop/governess.ts`,
  `loop-fork/tests/loop/run-state.test.ts`, `loop-fork/tests/loop/paired-options.test.ts`,
  `loop-fork/tests/loop/governess-runtime.test.ts`, and
  `loop-fork/tests/loop/governess-exit.test.ts`.
- Exclude planning, red evidence, evals, Harness lifecycle, matrix/status/PLAN, root `.loop/`, old
  handoff files, other defects, external Harvto, dependencies, utility/provider configuration,
  remotes, and deployment/release paths from the implementation commit.
- Obtain Claude zero-write literal `PASS` for the exact implementation SHA before one Harness close
  and separate bookkeeping commit.
