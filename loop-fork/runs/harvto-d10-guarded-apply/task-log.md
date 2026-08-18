# Task harvto-d10-guarded-apply

Created: 2026-08-18T08:17:07Z
Mode: emergent
Description: D10 P2: reproduce guarded patch apply against an absent target and make the guard fail closed with exact target evidence.

## What I changed

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

## Why

Proposal capture represented an absent target as a null preimage, and apply-time lookup also
returned null. The old equality check therefore treated absent/absent as authorized and allowed a
guarded patch to create a file before the runtime recorded `patch-applied`. D10 requires new
applications to have a non-null proposal digest that still matches current bytes, without breaking
recorded replay or disclosing file contents.

## Notes

- PLAN PASS: `e41e470d-d7a3-4107-93d0-a90feb717439`. RED VALID:
  `0e13914f-7fb6-4529-955e-692d8aff7dc5`. Exact-SHA implementation PASS:
  `183f6c68-edcc-43f0-8db6-f631ea4f131e`.
- The named regression and four focused suites passed. Check, canonical TypeScript, build, both
  empty-baseline allowlist checks, Harness preflight/stop-gate, and the non-TTY root verifier
  passed. The recovered plain serial suite certified all 79 sorted files.
- Two earlier serial bridge-timeout failures and the narrow-PTY root-verifier failure remain
  preserved as non-authoritative environment evidence. No bridge source or timeout changed.
- The first Harness close attempt exited before lifecycle transition because this task log section
  was empty. Its evidence is preserved under `artifacts/close/attempt-1/`; D10 remains
  active/pending/current with zero terminal rows until an authorized recovery close succeeds.
- Accepted behavior narrowing: a guarded utility patch that adds a target absent at proposal time
  now fails closed with expected/current absent evidence. This is intentional D10 behavior.
