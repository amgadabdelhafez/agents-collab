# Tasks: Utility scope-satisfiable capabilities and bounded evidence recovery

1. **Check in the run-151 producer fixture.** Copy the two job records and their
   tool-event streams read-only from
   `/Users/amgad/.loop/runs/harvto-b1e274e66299/151/utility/`, normalize with a
   checked-in script, and record provenance plus per-file SHA-256 in
   `fixture-index.json`. Include the empty tool-event stream for `b649045c`, the
   successful `propose_patch` artifact reference for `f155d583`, and the three
   verbatim `run_check` rejection messages.

2. **Establish the harness map before wiring.** From source, determine which of
   the three `assertConversationEvidence` call sites are conversational (Pi SDK
   and legacy) and which is Direct, and confirm where Pi disposes its session
   relative to the assertion. Record the finding; do not infer it from line
   numbers.

3. **RED: `run_check` is withheld when no declared cwd can satisfy it.** A broker
   built with a file-only read scope must not expose `run_check` in the tool
   `definitions`, the Pi active-tool set, or `describeCapabilities()`.

4. **RED: `run_check` stays exposed when a declared directory cwd can satisfy
   it.** Guards against over-fixing. Cover both the fallback `readScopes` path
   and an explicit `commandCwds`, across file-only, missing, and valid-directory
   candidates.

5. **RED: every exposure surface agrees.** `definitions`, the Pi active tools,
   `describeCapabilities().tools`, the advertised command prefixes, and the
   guidance string must all reflect the same withholding decision.

6. **RED: Pi recovery success.** Replaying the `b649045c` shape on the Pi
   harness, a first completion with zero tool evidence earns exactly one further
   turn on the same live session, and a following completion that calls an
   exposed tool succeeds.

7. **RED: legacy recovery success.** Equivalent behaviour on the legacy
   conversational harness.

8. **RED: recovery is bounded.** Two consecutive prose-only completions throw
   today's `${role} task completed without repository tool evidence`.

9. **RED: `CONTEXT_INSUFFICIENT` gets zero recovery** and stays terminal.

10. **RED: edit and command assertions remain terminal.** `kind: edit` without a
    validated patch artifact and `kind: command` without a successful `run_check`
    must not be routed through the generic recovery branch.

11. **RED: the recovery prompt names only currently exposed tools**, never a
    withheld `run_check`.

12. **RED: recovery widens nothing.** Identical tool set, read scope, write
    scope, authority flags, rejection counters, tool budgets, artifacts, and
    cumulative usage across the original and recovery turns.

13. **Implement A** — `run_check` satisfiability in `utility-tools.ts`, reusing
    the execution cwd policy rather than restating it, computed once as a
    broker-creation-time snapshot, and applied consistently to every exposure
    surface including the guidance string. Narrow to `run_check`; no general
    per-tool registry.

14. **Implement B** — bounded evidence-recovery turn in both conversational
    harnesses in `utility-runtime.ts`, fixed at one, deciding while the Pi
    session is still alive, continuing the same run rather than starting a new
    one, and leaving Direct, `CONTEXT_INSUFFICIENT`, fatal and provider errors,
    the `edit` and `command` assertions, and
    `MAX_CONSECUTIVE_BROKER_REJECTIONS` untouched.

15. **Confirm the preserved fail-closed paths** still hold: `kind: edit` without a
   validated patch artifact, and `kind: command` without a successful
   `run_check`, both still fail.

16. **Add `specs/utility-scope-evidence-recovery/verify.md` to the governed run**
    and confirm `scripts/verify.sh utility-scope-evidence-recovery` passes.

17. **Full verification.** Focused tests, all utility/broker/runtime suites,
    `bun run check`, `bun run build`, eval, clean scoped diff. No skipped or
    tolerated failures. Run the suite with `TMUX` unset.

18. **Commit, request native Codex exact-SHA review, stop at supervisor review.**
    No merge, rebase, push to main, or deploy. No install until supervisor and
    Codex jointly approve the exact candidate.
