# Task harvto-d16-scope-audit-completeness

Created: 2026-08-13T21:07:18Z
Mode: emergent
Description: D16 campaign-integrity P0: scope audit can return a clean verdict while omitting Git-derived modified paths; require complete added, deleted, renamed/copied, staged, committed-range, and tracked-but-routing-ignored path enumeration plus con

## What I changed

- Promoted the parked D16 task after D5's implementation and Harness bookkeeping commits.
- Initialized the Harness run plan and canonical D16 spec/plan/tasks/verify contract at exact base
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- Read the constitution, architecture/dependency boundaries, testing contract, campaign invariant,
  and the exact run-60 utility request/result records without routing any helper.

## Why

Run-60 job `3466ccae-7ca4-4eb9-be18-b645a77aa019` completed a successful `git-status` utility
audit after listing eight of Git's nine entries and omitting the populated D5 spec bundle. A second
successful broker-backed job declared that four-file bundle empty. D16 makes deterministic path
evidence, not synthesized prose, the authority for complete/clean scope verdicts.

## Notes

- Production and tests remain unchanged. Exact-base red is required before implementation.
- Root `.loop/` remains untracked and preserved.
- Utility, Au Pair, and delegation modes remain disabled; no helper was routed and no spend occurred.

## Historical evidence and source trace

- Recorded exact run-60 request/result facts and SHA-256 provenance in
  `artifacts/observed-false-negative.md` using native read-only inspection.
- Traced `git_status`/`git_diff` through provider synthesis, compact result persistence, store
  replay, bridge notification, and `get_task_result` in `artifacts/source-trace.md`.
- Root cause at the observed boundary: successful broker execution satisfies review evidence, while
  only free-form synthesis reaches the compact result; neither store nor consumer has canonical path
  count/hash evidence to reject an omission.
- Selected the fake-provider/real-broker Pi harness as the smallest exact-base red seam. No source or
  test edit has started yet.

## Exact-base red

- Added named regression `D16 utility scope audit preserves routing-hidden Git paths when synthesis
  reports only visible paths` with production unchanged at exact base
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`.
- Native fixture Git reports modified `src/tracked.ts` and untracked `specs/`; the real broker hides
  `specs/d16-fixture/spec.md` under routing policy, and the fake local provider sees/reports only the
  ordinary source path.
- Durable result still records `state=completed`, `status=completed`, and has no `scopeAudit` field.
  The expected two-record count/hash assertion fails decisively: 0 pass, 11 filtered, 1 fail.
- Preserved command, fixture, result, decisive assertion, and the setup-only precondition correction
  in `artifacts/red/reproduction.md`. Production remains unchanged.

## Implementation and verification

- Added canonical, hashed Git scope-audit collections and strict selection/path/replay validation
  across broker production, Direct execution, runtime completion, persistence, and bridge
  consumption.
- Added controls for worktree/index/range identity; added, deleted, renamed/copied, staged,
  unstaged, committed-range, and routing-hidden paths; zero-record clean state; omission, tamper,
  duplicate, malformed, truncated, orphan, narrowed, and legacy branches.
- Focused and affected matrix passes 354 tests. `bun run check` passes 893 files; canonical
  TypeScript and build pass; all 79 certified serial test files pass.
- Regenerated Harness and repository evals as passing with empty baseline failures. Harness
  preflight and stop-gate pass. Root `scripts/verify.sh` passes through its empty baseline allowlist.
- No UI changed. Utility remained disabled at `0/off/0`; no helper route or spend occurred.

Exact implementation staging/commit and Claude exact-SHA zero-write review remain before the one
Harness close.

## Exact-SHA review and close

- Implementation commit `7c7acdea58c16a3c72a64443f052849ad9fecf3d` contains exactly the 13
  authorized D16 source/test paths. Cached normal and ignore-all-space numstats matched; no
  bookkeeping, evidence, Harness, spec, root `.loop/`, provider, dependency, or remote path leaked.
- Claude peer task `509c6635-b7b6-406c-8159-a4ce4b19cd7d` returned literal zero-write `PASS`
  in decision `3c84f2b8-ca24-4238-a300-c5f307f6718d` for that SHA and parent
  `ee559c4f75dfe36e2dd61c607d48a3aba4faa500`, discharging obligations
  `cf060ab5-47b6-41c5-a52a-0894463b9054`, `3aebdf98-0649-4b70-9dc2-0108b8254e5f`, and
  `db2a8ff5-b447-406d-9e20-5e8957617312` without reopening settled C1-C6.
- Final preflight, stop-gate, and root verification all passed at the reviewed SHA. Harness was
  closed exactly once; post-task invariants passed, D16 is `done` with eval `pass`, and
  `.harness/current-task` is absent.

Claude recorded five non-blocking observations: empty diff scopes would currently produce a plain
error but are unreachable under boundedness; 40-hex declaration parsing is fail-closed but not
SHA-256-repository portable; malformed evidence may win reason-code precedence over orphan state;
one tampered event line invalidates the whole journal file; and proof prose must stay synchronized
with executable counts. None is a D16 correctness defect or reopens the gate.
