# Verify: Utility scope-satisfiable capabilities and bounded evidence recovery

1. Assert every regression was shown **failing on the unmodified base** before
   the fix landed, with that output captured under
   `runs/utility-scope-evidence-recovery/artifacts/`. A regression that has never
   been seen red does not count as coverage.
2. Assert a broker whose declared scopes are file-only does not expose
   `run_check` and does not advertise it in `describeCapabilities`.
3. Assert a broker with a satisfiable declared directory cwd still exposes
   `run_check` exactly as today, so the fix withholds only the impossible case.
4. Assert satisfiability is **derived from the job's declared scopes** and
   **reuses the execution cwd policy** rather than restating it: the derivation
   and `resolveCommandCwd` must agree on normalization, exact-vs-prefix
   semantics, realpath and containment, protection, and directory existence.
   Assert it is a broker-creation-time snapshot and that later filesystem drift
   can only fail closed, never widen exposure.
4b. Assert the claim is scoped to `run_check` only. No artifact may state or
   imply that every broker tool is satisfiability-filtered.
4c. Assert every exposure surface agrees: `definitions`, the Pi active-tool set,
   `describeCapabilities().tools`, the advertised command prefixes, and the
   guidance string. Cover both the fallback `readScopes` path and an explicit
   `commandCwds`, across file-only, missing, and valid-directory candidates.
5. Assert the helper guidance names the withheld tool and what remains, so a
   withheld tool cannot be silently invented.
6. Replay the `b649045c` shape on **both** conversational harnesses: a first
   completion with zero tool evidence earns exactly one further turn, and a
   following completion that calls an exposed tool succeeds. On the Pi harness
   assert the recovery decision happens while the same session is still alive.
6b. Assert `CONTEXT_INSUFFICIENT` receives zero recovery and stays terminal, and
   that fatal and provider errors stay terminal.
6c. Assert Direct receives no recovery.
6d. Assert the recovery prompt names only currently exposed tools and never a
   withheld `run_check`.
7. Assert the recovery is bounded: two consecutive completions with no tool
   evidence throw `${role} task completed without repository tool evidence`, the
   same error and terminal behaviour as today.
8. Assert the recovery turn continues the same run and widens nothing: identical
   broker instance, definitions and active tools, read scope, write scope,
   authority flags, timers, rejection counters, tool budgets, artifacts, and
   cumulative usage and accounting across the original and recovery turns.
9. Assert the recovery budget is fixed at one and cannot be raised by helper
   input.
10. Assert the preserved fail-closed paths are intact and are **not routed
    through the generic recovery branch**: `kind: edit` without a validated patch
    artifact still fails, `kind: command` without a successful `run_check` still
    fails, and `MAX_CONSECUTIVE_BROKER_REJECTIONS` is unchanged.
11. Replay the `f155d583` shape and assert that with the fix the helper is never
    offered `run_check`, so its three rejection rounds cannot occur and the
    `propose_patch` artifact survives.
12. Assert OSS approval remains advisory; no release authority is granted.
13. Assert the fixture is producer-derived: `fixture-index.json` per-file SHA-256
    values match the checked-in bytes and the normalizer reproduces them.
14. Run the affected test files, all utility/broker/runtime suites,
    `bun run check`, `bun run build`, and
    `scripts/verify.sh utility-scope-evidence-recovery`, with `TMUX` unset. No
    skipped or tolerated failures, and a required-empty named baseline allowlist.
