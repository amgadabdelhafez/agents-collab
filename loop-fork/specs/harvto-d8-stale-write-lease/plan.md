# D8 Plan

1. Enforce Required behavior 12 across this complete five-file contract. After planning edits stop,
   freeze all five hashes, re-derive them immediately before one fresh Claude zero-write full-file
   review at exact base `66fd1e13745832cfb959e9fb1b3fb295f2ba5ee9`, and re-derive them when the
   verdict arrives. Only literal `PLAN PASS` naming the base and every current hash grants
   source/test/red authority.
2. At unchanged production bytes, add only
   `D8 stale utility write authority rejects before two-file mutation` to
   `tests/loop/utility-runtime.test.ts`. Build two present valid fixture files, route and claim the
   edit at epoch 30, create one aggregate proposal, complete it, advance only the current utility
   epoch to 31, and invoke `applyUtilityJobPatch`. Base must resolve and apply both files rather
   than reject. Freeze the exact command, fixture, test diff, output, hashes, and authority tuple in
   the six-file red directory.
3. If and only if the decisive red reproduces, add async `withUtilityPatchAuthority` in
   `utility-store.ts`. Its awaited lock variant retains and refreshes the owned lock through the
   callback, validates current/route/claim authority under that lock, and releases only after the
   awaited callback and any application append complete. Do not pass a Promise through synchronous
   `withStoreLock`.
4. Extract the existing application append/dedupe body into internal
   `recordUtilityPatchApplicationLocked`. Public
   `recordUtilityPatchApplication` keeps its current lock-owning API and calls that helper; the
   async authority section already owns the lock and calls the helper directly, avoiding
   non-reentrant reacquisition.
5. Make `applyUtilityJobPatch` perform artifact/workspace/broker work only inside the authorized
   async callback. A rejected authority must not construct or reach `broker.applyPatchProposal`;
   an applied result journals once before authority is released.
6. Add negative controls for changed epoch, missing claim, route/claim mismatch, and activation/apply
   ordering. Every negative case asserts the authority error, unchanged hashes for both files, and
   zero `patch-applied` events. The ordering control holds the async mutation callback open while
   activation contends: activation cannot interleave or return false; it either succeeds after
   release or throws `utility store is busy` under the existing deadline.
7. Add positive controls for one current-authority two-file apply and same-authority replay returning
   `already-applied` with one application event. Keep broker preimage/applicability and linked
   workspace controls green without editing their control-only files.
8. Run the named regression and focused files, then mandatory check, TypeScript, build, and plain
   `bun run test:ci`. Generate both evals only from actual green results, validate each baseline
   allowlist, run Harness preflight/stop-gate, and run the root verifier as the sealing repeat.
9. Reconcile normal and ignore-all-space numstats over exactly the two production and two test
   paths. Commit only that implementation scope, obtain Claude exact-SHA literal `PASS`, close
   Harness once, and commit lifecycle/evidence/ledger bookkeeping separately.

If unchanged base does not apply both valid fixture files after only the current epoch advances,
record `not-reproduced` and stop. Do not perturb fixture bytes, widen into D10 broker guards, edit a
control-only file, or weaken the authority critical section to a racy precheck.
