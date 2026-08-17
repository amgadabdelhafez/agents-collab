# Run Plan — harvto-d8-stale-write-lease

Base: `66fd1e13745832cfb959e9fb1b3fb295f2ba5ee9`

1. Freeze this complete five-file contract under Required behavior 12 and obtain fresh Claude
   literal `PLAN PASS` naming the exact base and all five hashes before source, test, or red work.
2. Preserve one exact-base red where two valid, applicable fixture files mutate after only the
   current utility epoch advances beyond the job's matching route and claim epoch.
3. Add async `withUtilityPatchAuthority` with owned lock refresh through the awaited mutation. Use
   internal `recordUtilityPatchApplicationLocked` so the section never re-enters synchronous
   `withStoreLock`.
4. Route `applyUtilityJobPatch` through that section so invalid authority rejects before broker
   creation/application, with no file mutation and no `patch-applied` event. Racing activation
   cannot interleave or return false for contention; it advances after release or throws busy.
5. Prove changed/missing/mismatched authority rejection, awaited-lock activation/apply ordering, one valid
   two-file apply, and one-event `already-applied` replay. Preserve D10 and linked-worktree guards.
6. Run focused and mandatory gates in order, generate and validate both evals, pass Harness gates,
   and use the root verifier as a sealing repeat.
7. Commit only the exact two-production/two-test implementation scope, obtain Claude exact-SHA
   `PASS`, close once, and commit bookkeeping separately before governed handover.

D8 does not require a completed worker PID to stay alive, edit broker object guards, repair Run86,
change utility `0/off/0`, or begin D9.
