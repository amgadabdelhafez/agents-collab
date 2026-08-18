# D10 Guarded Apply Requires an Existing Exact Target

## Problem

At exact implementation base `1282bd4c39ec7b3c0177810b30dab78ca6d66f41`,
`applyUtilityJobPatch` in `src/loop/utility-runtime.ts` revalidates live D8 utility authority,
selects one hash-bound patch and manifest, builds an exact-scope `UtilityToolBroker`, and records a
`patch-applied` event only after `UtilityToolBroker.applyPatchProposal` returns `applied`.

`applyPatchProposal` validates artifact paths and hashes, parses the proposal manifest, extracts and
revalidates exact patch targets, compares the target list with proposal preimages, handles
same-application replay, checks preimages, runs `git apply --check`, checks preimages again, performs
the real apply, and captures postimages. Proposal creation intentionally supports an exact declared
new write file: an absent target is recorded with `sha256: null`, and a valid creation patch passes
the proposal-time applicability probe. At apply time the same absent target also hashes to `null`,
so the current equality check treats absence as authority to create the file. The full-agent
guarded-apply boundary therefore accepts a creation that has no existing target bytes to guard.

## Required behavior

1. A new guarded patch application requires every exact target to exist and every proposal
   preimage to contain a non-null SHA-256. `sha256: null` remains valid proposal evidence, but it is
   never creation authority at apply time.
2. After artifact, hash, manifest, target, exact-scope, dependency, and symlink validation, but
   before either `git apply` command, guarded apply compares each proposal preimage with the current
   exact target. An expected-null/current-absent pair is rejected rather than accepted.
3. A target removed after proposal is rejected. A target whose exact bytes changed after proposal
   is rejected. Both failures occur before mutation and before `patch-applied` journaling.
4. D10 preimage and applicability failure evidence identifies only the exact normalized target path
   and the expected and current preimage state. A state is `absent` or its SHA-256 digest; file
   contents and unrelated repository bytes are never included.
5. A patch whose target and preimage are exact but whose hunks are malformed or no longer cleanly
   applicable is rejected by the existing `git apply --check` boundary before real apply and before
   journaling. Its bounded error includes the exact target and unchanged expected/current preimage
   states. D10 does not weaken, bypass, or replace Git applicability validation.
6. The post-`--check` preimage recheck remains. Concurrent target drift between the first preimage
   comparison and real apply fails with the same exact expected/current evidence and no application
   record.
7. A valid existing-target patch applies once and records exact preimages and postimages. A
   previously recorded same application still checks its postimages and returns `already-applied`
   without another mutation or `patch-applied` event. This replay path is evaluated before the new
   application eligibility check so historical application records remain replayable.
8. D8 actor authority remains outermost. Missing, dead, or stale route/claim/current-epoch authority
   still rejects in `withUtilityPatchAuthority` before broker artifact, preimage, or applicability
   work. D10 does not absorb or alter that invariant.
9. Patch and manifest hashes, manifest-to-artifact binding, target/preimage equality, exact write
   scope, repository containment, symlink protection, dependency denial, patch-size limits,
   postimage drift, proposal-only new-file support, and existing-target behavior remain compatible.
10. The bounded production scope is exactly `src/loop/utility-tools.ts`. The exact-base journal
    regression requires `tests/loop/utility-runtime.test.ts`; broker-level diagnostic and ordering
    controls require `tests/loop/utility-tools.test.ts`. `src/loop/utility-runtime.ts`,
    `src/loop/utility-store.ts`, schemas, dependencies, and all other source are read-only.
11. Every planning-byte change invalidates all five D10 contract SHA-256 values. Freeze all five
    together after planning edits stop, re-derive immediately before one fresh Claude complete-file
    zero-write review at exact base `1282bd4c39ec7b3c0177810b30dab78ca6d66f41`, and re-derive on
    verdict receipt. Only literal `PLAN PASS` naming that base and all five current hashes grants
    source, test, red-evidence, eval, or staging authority. Two consecutive non-converging `REVISE`
    verdicts on the same premise stop and escalate.

## Exact-base regression

The named regression is:

`D10 guarded apply rejects absent null-preimage target before mutation and journaling`

It uses the real utility job, proposal, guarded apply, and append-only store path. One exact declared
target is absent. The patch is a valid creation-style patch; proposal and completed-job artifact
metadata carry the correct patch and manifest hashes; the manifest carries the target with a null
preimage; live route, claim, and current epochs match; all other applicability and authority inputs
are valid. The expected outcome is a pre-mutation rejection naming the target and
expected/current absent states, target absence after the call, and zero `patch-applied` events.
Unchanged base is genuinely red because it creates the target and records one application event.
A hash, manifest, scope, authority, symlink, dependency, or malformed-patch rejection is false red.

## Compatibility and boundaries

- D10 does not reopen D8 authority, D9 acknowledgement emission, D6/D7 evidence, or any prior
  Harness close. D11 and D12 remain parked and forbidden.
- No utility, Au Pair, Nanny, helper route, native fallback, provider/model/dependency change,
  Harvto mutation, remote, merge, rebase, push, deploy, release, schema migration, or journal
  rewrite is in scope. Utility remains exact `0/off/0`.
- No rendered UI changes are present. Screenshot and DOM capture are not required.
- Planning, Harness lifecycle, red/verification evidence, evals, root ledgers, and handover records
  are bookkeeping scope and are excluded from the implementation commit.
- Existing dirty and untracked evidence is preserved. No directory or glob staging is allowed.

## Acceptance

- The unchanged-base named regression creates the absent target and records one application event;
  those exact observations are frozen as genuine red and receive Claude literal `RED VALID`.
- After the fix, absent/null-preimage, removed-target, changed-target, and non-applicable cases reject
  before mutation and journaling with bounded target/preimage evidence.
- Valid existing-target apply and same-application replay remain green, as do D8 authority, runtime,
  workspace, bridge-utility, scope, hash, manifest, symlink, dependency, and postimage controls.
- Focused and mandatory gates pass. Task-local and repository-root evals are honest pass records
  with `baseline_failures: []` and no by-name baseline allowlist entries.
- One implementation commit containing only the three exact production/test paths receives Claude
  literal zero-write `PASS` for its exact SHA. Harness then closes D10 exactly once, separate
  bookkeeping receives literal `BOOKKEEPING PASS`, and Run93 hands over without starting D11/D12.
