# Run Plan — harvto-d7-handoff-identity

Base: `2c415e124c4cb2b39d81fa19a8e977e50dba48a9`

1. Enforce canonical spec Required behavior 11: every planning-byte change invalidates all five
   hashes; after edits stop, freeze the complete set and obtain one fresh Claude zero-write full
   review of all five complete files at exact base. Re-derive hashes immediately before request and
   on verdict receipt; only literal `PLAN PASS` naming the base and all five current hashes permits
   source/test edits or red capture.
2. Preserve the named exact-base end-to-end red with zero prior `src/` change: replacement argv
   passes through the real parser into `Options`, then existing base-reachable
   `tmuxInternals.buildPairedAgentCommand` returns launch argv carrying hostile ambient
   `gpt-5.6-luna` instead of source `gpt-5.6-sol`. No export or resolver extraction precedes red.
3. Only after red is frozen, declare the shared launch-identity type in `src/loop/run-state.ts`,
   make effective-model resolution shared, and persist normalized launch identity from that same
   resolver used by tmux commands.
4. Digest-bind source run/repo/workspace/topology/model/effort identity and pass role-correct model
   flags to a fresh replacement run.
5. Reject parent-provable Claude-primary inexpressibility before spawn. Persist exact source
   lineage and reject replacement binary/default drift through exact replacement
   run/repo/manifest/session/epoch identity comparison before acceptance or old-loop teardown.
6. Prove positive, mismatch, legacy, tamper, workspace, restart, replay, and isolation controls.
7. Verify, commit only the frozen six-source/four-test scope, obtain Claude exact-SHA `PASS`, close
   once, and commit bookkeeping separately.

D7 does not reuse the live parent run ID, add a model-transition UI, repair a live estate, or begin
D8.
