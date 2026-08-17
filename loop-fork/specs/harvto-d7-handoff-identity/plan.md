# D7 Plan

1. Enforce Required behavior 11 across this complete five-file contract. Every planning-byte
   change invalidates all five hashes. After edits stop, compute the complete set together,
   re-derive it immediately before one fresh Claude zero-write full-file review at exact base
   `2c415e124c4cb2b39d81fa19a8e977e50dba48a9`, and re-derive it again when the verdict arrives.
   Prior section acceptance and delta-only review do not carry forward. Only literal `PLAN PASS`
   naming the exact base and all five current hashes authorizes source, regression, red-evidence,
   or lifecycle edits; every invalid verdict or later planning edit requires a planning-only full
   re-freeze and review, subject to the two-`REVISE` escalation cap in Required behavior 11.
2. At unchanged production base, add only the named fixture-owned regression `D7 governed handoff
   preserves exact effective launch identity`. Give it a source Codex identity of
   `gpt-5.6-sol`/high and hostile ambient `gpt-5.6-luna`/low defaults. Feed replacement argv through
   the real argument parser into `Options`, then call existing base-reachable
   `tmuxInternals.buildPairedAgentCommand`. The decisive assertion proves its returned launch argv
   carries effective Codex model `gpt-5.6-luna`, not source `gpt-5.6-sol`; omitted
   `--codex-model` is secondary evidence only. Preserve the command, fixture, decisive
   resolved-model assertion, replacement argv, parsed `Options`, returned launch argv, exit, and
   source hashes under `runs/harvto-d7-handoff-identity/artifacts/red/`; never recapture or
   overwrite it. No export, resolver extraction, or other `src/` byte change may precede red.
3. Only after step 2 red is frozen, make the tmux command's effective-model resolver shared and use
   that one resolver when writing the run manifest. Persist exact per-agent effective models with
   the existing primary agent, topology, role efforts, cwd, repo/run IDs, and workspace binding.
   On a live-pane resume, restore the persisted identity or reject an explicit conflict; do not
   relabel an already-running pane with a newly resolved default.
4. Declare and export the normalized, stable launch-identity type in `src/loop/run-state.ts`, within
   the frozen ten-file boundary, and project it rather than hashing mutable manifest bytes. Extend
   the handoff manifest canonical digest with the source run/repo identity, normalized workspace
   binding, source manifest-identity digest, primary/peer topology, per-agent effective models, and
   role efforts. Keep bundles, continuation, and epoch digest-bound as today.
5. Extend replacement argv with role-correct existing model flags for Codex, Gemini, Copilot,
   Cursor, and a Claude reviewer. Persist and validate the fixed Claude primary model even though
   no primary override flag exists. Parent-side validation fails before spawn when the frozen value
   is already inexpressible under the parent's current Claude-primary CLI/default contract. A
   replacement binary/default drift is instead detected by replacement-side identity comparison
   before acceptance; the parent keeps the old loop intact. Keep `cwd` equal to the normalized
   workspace root and do not reuse the live parent run ID.
6. On replacement startup, compare the replacement run manifest's normalized launch identity with
   the handoff target before accepting. Persist source lineage in the replacement manifest and bind
   acceptance to handoff digest, source identity, replacement run/repo/manifest identity, session,
   and a strictly newer Governess epoch. Any missing or unequal field returns no acceptance.
7. Keep parent teardown behind the exact acceptance read. A launch error, dead or unready
   replacement, missing acceptance, stale epoch, legacy-incomplete identity, tamper, model/effort
   drift, workspace drift, topology drift, or lineage drift leaves mark/kill effects at zero.
   Restart reuses the frozen handoff transaction identity and replay remains idempotent.
8. Add named controls for run-manifest round-trip and malformed identity rejection; primary and
   reviewer model-flag mapping; asymmetric efforts; manifest/continuation/bundle/identity tamper;
   exact fresh-run lineage; exact workspace root/repo/branch; missing legacy fields; replacement
   mismatch; unexpressible model; launch failure; restart; and duplicate acceptance/teardown
   prevention.
9. Run focused and mandatory verification, both eval schemas, Harness gates, and the root verifier.
   Reconcile Git-derived scope, commit only the six production and four regression paths named in
   the spec, obtain Claude exact-SHA literal `PASS`, close Harness once, and commit lifecycle and
   evidence separately.

If the exact-base regression does not fail because real replacement argv parsing followed by
base-reachable `tmuxInternals.buildPairedAgentCommand` carries hostile ambient `gpt-5.6-luna`
instead of source `gpt-5.6-sol`, record `not-reproduced` and make no production edit. Do not treat a
literal replacement-argv assertion as decisive. Do not widen D7 into a model-transition UI, live
estate repair, workspace ownership relaxation, D8 authority work, or same-run-ID reuse.
