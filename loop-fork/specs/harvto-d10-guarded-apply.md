# harvto-d10-guarded-apply

Task completed 2026-08-18T16:06:48Z, mode emergent.

## What was built

- Committed `3be913deedf27357b64bf9f9fe1c9788c74dfa2b` on plan-freeze parent
  `e632e54ffa1239ada679abf55eca75471e2ce851`, changing exactly
  `src/loop/utility-tools.ts`, `tests/loop/utility-tools.test.ts`, and
  `tests/loop/utility-runtime.test.ts`.
- Kept recorded application replay first, then made every new guarded application reject a null,
  removed, or changed preimage before Git; repeated the guard after `git apply --check` and before
  the real apply.
- Limited apply-time diagnostics to normalized target plus expected/current digest-or-absent
  evidence, while retaining proposal-time applicability diagnostics, postimage validation, valid
  existing-target apply, and replay.
- Added broker controls for absent, removed, changed, non-applicable, concurrent-drift, valid
  existing-target, ordinary replay, and historical null-preimage replay cases. Added the runtime
  regression proving no target mutation and no `patch-applied` journal event.
- Updated the existing runtime multifile fixture to modify two present targets instead of relying
  on guarded creation.

## Decisions made

- Promoted parked idea `specs/harvto-d10-guarded-apply.md` into active task `harvto-d10-guarded-apply`.
- Commit `3be913deedf27357b64bf9f9fe1c9788c74dfa2b` is the exact reviewed three-file D10
  implementation on plan-freeze parent `e632e54ffa1239ada679abf55eca75471e2ce851`.
- Claude decision `183f6c68-edcc-43f0-8db6-f631ea4f131e` is literal zero-write `PASS`; the
  exceptional recovery close was separately authorized only after task-log decision
  `8990382a-cbb2-4927-9953-66f70b8d3122` returned literal `REPAIR VALID`.
- Guarded apply intentionally rejects absent/null proposal preimages for new application while
  preserving recorded replay, including historical null-preimage replay.
- The premature red bundle and failed PTY verifier remain preserved as non-authoritative incident
  evidence; the post-freeze red bundle and successful non-TTY verifier are authoritative.

## Open items at completion

_No D10 implementation items remain open. Separate bookkeeping commit and review remain pending._

## Trajectory

- 001 - initial (2026-08-18T08:17:07Z)
- 002 - promoted parked idea (2026-08-18T08:17:07Z)
