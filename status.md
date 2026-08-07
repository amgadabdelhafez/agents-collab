# status — Utility scope-satisfiable capabilities and bounded evidence recovery

Worktree: `/private/tmp/agents-collab-utility-scope-evidence-recovery`
Branch: `codex/utility-scope-evidence-recovery`
Base: `defdf74949e34fe69b0f8e8601bba0afa152585f` — supervisor-cleared OSS-seat
lineage, also `main`. Not `origin/main` (`0f69b9a…`, older).
Spec bundle: `specs/utility-scope-evidence-recovery/{spec,plan,tasks,verify}.md`.

Authorized by founder directive relayed as work request
`338d1fcf-6b4a-41fa-9d62-11f9b3f92595`. Plan approved with six required
amendments in `0a27f1ab-9e4f-4522-a70a-aea69aeff0a3`, all applied to the bundle
before any source work.

## State: both defects complete; Codex-approved; supervisor gate remains

Code candidate: **`6dec6fe3b61cd3c1555b2c7036bfa90468f1a141`**, Codex
`TECHNICAL APPROVE / PASS within Codex authority` (`814d5944-6eb1-45e2-91ca-1306c6c705ca`),
reviewed under model **luna** on native Codex pane `%8` under supervisor
ratification `c7f6494e-57e7-48d2-9dd7-72f337e5ffab`.

Codex explicitly withheld merge, deploy, and release PASS. **Supervisor
exact-SHA review is the remaining gate.**

This provenance is recorded in an evidence-only commit *on top of* the approved
SHA, at Codex's direction, so `6dec6fe3…` itself is not moved.

Review history: `c8115e7c` held on four findings; `a311db29` held on a committed
trailing-whitespace blob; `264d9e14` held for the missing read-plan regression;
`6dec6fe3` approved. Each hold was a real defect in what I claimed or proved, not
in the shipped behaviour, with one exception — the read-plan union bug in
`evidenceRecoveryPrompt` was a genuine code defect Codex found.

### Delivery caveat carried forward

`pending.supervisor` measured **5**, oldest `2026-08-07T03:43:52.763Z`, so
supervisor-facing sends from this session have been stranded for ~15.5 hours and
every supervisor ruling reached me through Codex relay. An authorized one-line
pull nudge drained `pending.codex` 3 -> 0 (verified after a bounded 45s wait; an
immediate check still read 3 and would have been a premature conclusion). The
supervisor path was not covered by that nudge. Codex filed it as a separate
governed loop; run 9 does not fix it.

## Isolation

The Claude kickoff submit guard candidate
`951ea73eb1ab00a2677c3cf93eeeb080daf8f211` lives in a separate worktree,
`/private/tmp/agents-collab-claude-kickoff-submit-guard`, verified clean and
untouched. Nothing from this task may be amended into it.

## Harness map, established from source

- `utility-runtime.ts:1384` → `runLegacyUtilityConversation` (declared `:1302`),
  legacy conversational.
- `utility-runtime.ts:1542` → `runDirectUtilityConversation` (declared `:1491`),
  **Direct — receives no recovery.**
- `utility-runtime.ts:1957` → `runPiUtilityConversation` (declared `:1779`),
  Pi SDK conversational.
- `session.dispose()` at `:1874` and `:1949`, both **before** the assertion at
  `:1957`. The Pi recovery hook must therefore sit inside the `try`, after
  `await session.waitForIdle()`, before the `finally`.

Recorded from source rather than inferred from the line numbers, because the
line numbers alone would have suggested three interchangeable call sites.

## Defect A — implemented, RED-evidenced, committed

RED captured on the unmodified base at
`runs/utility-scope-evidence-recovery/artifacts/red-defect-a-unmodified-base.txt`:
3 fail / 2 pass. The three failures are the new-behaviour assertions, each
failing for the intended reason — `Expected to not contain: "run_check"`,
`Received: [ "read_file", "run_check" ]`. The two passes are deliberate
preserved-behaviour guards and are green on base by design. That artifact was
later stripped of three trailing-whitespace lines to satisfy `git diff --check`;
the edit is recorded in `eval.json` with before/after hashes, so it is captured
output with whitespace stripped rather than a byte-verbatim capture.

Implementation, `loop-fork/src/loop/utility-tools.ts`:

- `hasSatisfiableCommandCwd()` calls **`resolveCommandCwd` itself**, so
  satisfiability and enforcement cannot drift apart. No second predicate.
- **Behaviour change worth a reviewer's eye**: `resolveCommandCwd` did not assert
  the cwd is a directory. A declared FILE path passed scope, realpath, and
  containment, and failed later as an opaque spawn error. Added
  `Command cwd is not a directory`, covered by its own regression asserting the
  command never runs.
- `narrowUnsatisfiableCapabilities()` runs last in `validateConfiguration`, once,
  as a broker-creation-time snapshot.
- Withheld-capability guidance is helper-visible: the reason names `run_check`,
  the command directories that failed to resolve, and what remains. It rides the
  capsule and the denial path.
- Scoped to `run_check` only. No general per-tool satisfiability registry.

## Defect B — implemented in both conversational harnesses, committed

One bounded recovery turn, budget fixed at 1. `needsEvidenceRecovery` refuses
recovery for a spent budget, any fatal error, `kind: edit`, `kind: command`, and
`CONTEXT_INSUFFICIENT`. Pi issues the recovery prompt inside the `try` after
`waitForIdle()`, because the `finally` disposes the session before the assertion.
Legacy continues the same loop. Direct receives none.

`evidenceRecoveryPrompt` builds from `broker.definitions`, **not**
`describeCapabilities().tools`: for a multi-step read-plan broker the latter
unions every future step. Codex found that; it is fixed and proved by a
regression that was verified RED by temporarily reverting the fix.

## Verification

- `env -u TMUX -u TMUX_PANE scripts/verify.sh utility-scope-evidence-recovery utility-scope-evidence-recovery`
  → **exit 0, 1587 tests, 0 failures, empty baseline allowlist**.
- Focused: `utility-scope-evidence-recovery` 7/0, `utility-evidence-recovery`
  7/0, `utility-evidence-recovery-legacy` 2/0, `utility-runtime` 53/0,
  `utility-pi-harness` 11/0, `utility-tools` 49/0, plus the rest of the utility
  surface green.
- `git diff --check` against base exits 0.

## Dependency bootstrap — authorized, executed once, evidence recorded

The earlier blocker (three suites unable to load without `node_modules`) was
resolved under supervisor authority `c52c6314-519b-4ced-ac42-b2d4bfc0c0c7`: one
`bun install --frozen-lockfile`, exit 0, lockfile sha256
`31d0bdb8a54bae9fd4dc29d287013e2a1821041072839b9859c6c9362273c321` identical
before and after, no global install, `node_modules` state hash
`d19010b928c017280e85f7578fb1c3f33d428aae4a55bbae47545cbf84490434` over 146
packages. Full chain at
`runs/utility-scope-evidence-recovery/artifacts/dependency-bootstrap-evidence.txt`.

## What should happen next

1. **Supervisor exact-SHA review of `6dec6fe3b61cd3c1555b2c7036bfa90468f1a141`.**
   That is the only outstanding gate for this task. Codex withheld merge, deploy,
   and release PASS.
2. Nothing else is required from this session. Do not merge, rebase, push to
   main, deploy, or install further.

## Separate, and also awaiting supervisor exact-SHA review

The Claude kickoff submit guard candidate
`951ea73eb1ab00a2677c3cf93eeeb080daf8f211` is Codex-approved and its earlier
prohibited-`bun install` process hold was **accepted and cleared** by the
supervisor. It too waits only on exact-SHA supervisor review.
