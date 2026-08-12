# Task harvto-supervisor-defects

Created: 2026-08-12T16:39:48Z
Mode: planned
Description: Reproduce and fix Harvto-reported paired-loop delivery, manifest liveness, routing, and completion-signal defects with exact-SHA peer review.

## What I changed

Built the defect matrix at `runs/harvto-supervisor-defects/artifacts/defect-matrix.md` from
the read-only Harvto evidence, then fixed the two defects whose invariants I could prove
missing against baseline `0f69b9a99f9163bf9f83075530e26aed21258463`.

D2 (P0, lying liveness) — `src/loop/launch-reservation.ts`. `manifestCanStillOwnWorkspace`
fell back to `isActiveRunState(manifest.state)` when the manifest-recorded tmux target was
dead. That is a claim the manifest makes about itself before a crash, not evidence anything
survived it, so crashed starts and legacy ghosts owned their workspace forever. Extracted
`liveManifestPid(manifest, deps)` — the predicate already used by the sibling path
`reserveRequestedLaunch` — and made ownership require a live `launchAttemptPid`, or a live
`pid` while the run still claims an active state. Live and unknown tmux behavior is
unchanged, so unknown still fails closed. Both call sites now share the one helper.

D13 (test isolation, found while establishing the D2 baseline) — `tests/loop.test.ts`, no
production change. The suite inherited `process.env.TMUX` from the loop's own tmux pane,
which routed three "started outside tmux" tests down the in-tmux branch of
`src/cli.ts:79-80`. Because `tests/loop.test.ts` sorts first and `bun run test:ci` exits on
the first failing file, this presented as a fully red mandatory suite when the untouched
baseline was green. Added `setTmuxEnv` plus file-level neutralization, and fixed three
existing restore sites that assigned `undefined` into `process.env.TMUX` (Node coerces that
to the truthy string `"undefined"`, which would have poisoned later tests the moment TMUX
was genuinely unset).

## Why

The spec requires that absence of liveness or routing evidence fail closed rather than look
healthy, and that liveness come from the exact manifest-recorded tmux target plus positive
process evidence. D2 was the direct violation. D13 is in scope because it decided whether
any proof command in this campaign could be believed at all: the environment that made the
suite lie is precisely the environment loop agents run in.

## Notes

- Full-suite comparison run file-by-file with no early exit, because `bun run test:ci`
  aborts on the first failure and hides everything after it. Baseline 1532 pass / 3 fail,
  patched 1539 pass / 3 fail, failure sets diffed by NAME and identical. After D13 the
  suite is 1542 pass / 0 fail across 77 of 77 files, recorded by
  `./harness verify unit -- bun run test:ci` (`eval.json` status `pass`, exit 0). After the
  two extra terminal-state controls Codex asked for, the suite is 1544 pass / 0 fail.
- `bun run check` reports 4 errors both before and after this change, all in
  Harness-generated evidence JSON under `runs/`. Touched files were formatted with biome
  directly rather than `bun run fix`, which would rewrite that evidence.
- Proof-command deviation, flagged not silently substituted, and recorded in the Harness
  evidence chain rather than only in prose. The slice names
  `./harness verify unit -- bun test`. That exact command was run as attempt-002 and
  refused deterministically at exit 2 by the repo guard in `tests/setup.ts:5-9`:
  "[loop] direct `bun test` is unsupported because Bun can terminate a shared-process suite
  before all files run". That is a tool-contract refusal, not a product or test failure --
  no test executed. `bun run test:ci` is authoritative for the complete suite per
  `package.json:15` and `AGENTS.md:8`, and was run as attempt-003: 1544 pass / 0 fail across
  77 of 77 files, exit 0. Current unit evidence and `./harness preflight --json` are green.
- Three pre-existing launch-reservation tests had ghost fixtures (`pid: 999` against a
  `reservationDeps` that reports only 4242 alive). Fixtures updated to carry real liveness;
  no assertion changed. Codex peer confirmation requested on that judgment call.
- D1 (delivery expiry ignores peer liveness) and D3 (`route_task` pending-route forever)
  are traced and reproduced but NOT yet fixed. D3 has a live first-party reproduction in
  this run: three real packets still `pending-route` with zero `route-decided` events.
- Delegation note: the utility tier could not accept work in this run — which is D3 itself —
  so this slice proceeded natively, on the precedent of Harvto ruling
  `1b63c048-22d0-4ecf-aabe-e13ae990ef31`.

Regression: yes
Regression id: launch-manifest-lying-liveness
Regression symptom: A crashed start or legacy manifest ghost holds a workspace forever, so every later launch fails with "still owns workspace" until the manifest is archived by hand.
Regression guard: tests/loop/launch-reservation.test.ts

Regression: yes
Regression id: loop-cli-test-tmux-env-leak
Regression symptom: The mandatory suite fails only when run from inside a tmux pane, so agents cannot trust their own proof runs.
Regression guard: tests/loop.test.ts
