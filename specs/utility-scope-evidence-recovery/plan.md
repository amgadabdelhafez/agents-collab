# Plan: Utility scope-satisfiable capabilities and bounded evidence recovery

Worktree: `/private/tmp/agents-collab-utility-scope-evidence-recovery`
Branch: `codex/utility-scope-evidence-recovery`
Base: `defdf74949e34fe69b0f8e8601bba0afa152585f` — the supervisor-cleared
OSS-seat lineage, which is also `main`. **Not** `origin/main`, which is older at
`0f69b9a99f9163bf9f83075530e26aed21258463`.

Isolation: the Claude kickoff submit guard candidate
`951ea73eb1ab00a2677c3cf93eeeb080daf8f211` lives in a separate worktree at
`/private/tmp/agents-collab-claude-kickoff-submit-guard` and is not touched here.
Nothing from this task may be amended into it.

## Verified facts this plan rests on (read from source and producer logs)

- `utility-tools.ts:1271` — `commandCwds = (config.commandCwds ?? config.readScopes)`.
- `utility-tools.ts:1274` — `commandCwdsAreExact = config.commandCwds !== undefined`,
  so the `readScopes` fallback uses prefix containment, not exact match.
- `utility-tools.ts:2013-2022` — `resolveCommandCwd` denies an out-of-scope cwd,
  then requires the value to resolve to an existing directory. A file-only scope
  set therefore admits nothing.
- `utility-tools.ts:1317` — `describeCapabilities` advertises `run_check`
  prefixes whenever `allowedTools.has("run_check")`, with no satisfiability test.
- `utility-runtime.ts:1274-1276` — `successfulTools.size === 0` throws
  immediately; there is no retry.
- `utility-runtime.ts:1245-1272` — `kind: edit` requires `propose_patch` plus a
  `.patch` artifact; `kind: command` requires a successful `run_check`. Both stay.
- `utility-runtime.ts:1626` — `MAX_CONSECUTIVE_BROKER_REJECTIONS` produces the
  message that ended job `f155d583`.
- Job `f155d583` reached `propose_patch` **successfully** before dying, so it
  failed on the rejection budget, not on the evidence assertion.
- Job `b649045c` recorded zero tool events, so it failed on the evidence
  assertion at `utility-runtime.ts:1275`.

## Design

### A. `run_check` satisfiability, `utility-tools.ts`

Narrow by design: this establishes satisfiability filtering **for `run_check`
only**, not a general per-tool registry. Codex required that narrowing, and the
spec wording was corrected to match.

The required input is a cwd that is simultaneously in `commandCwds` and an
existing directory. The derivation must **reuse the execution policy rather than
restate it**: the same `normalizeRequestedPath`, the same exact-vs-prefix branch
selected by `commandCwdsAreExact`, the same `realpath` plus repository
containment, the same protected-path check, and the same directory-existence
requirement that `resolveCommandCwd` applies. A second, looser predicate that
could disagree with enforcement is precisely the failure mode to avoid, so the
shared logic is factored out and called from both places.

Satisfiability is a **broker-creation-time snapshot**, computed once during
`create`/`validateConfiguration`. Later filesystem drift may only cause a call to
fail closed at execution time; it must never retroactively widen exposure.

The decision must reach **every exposure surface consistently**: the tool
`definitions` actually offered, the Pi active-tool set, `describeCapabilities()`
including its `tools` list and command prefixes, and the denial and guidance
strings at `:1812`. Coverage must exercise both the fallback `readScopes` path
and an explicit `commandCwds`, across file-only, missing, and valid-directory
candidates.

### B. Bounded evidence recovery, `utility-runtime.ts`

Applies to the **generic evidence-free conversational completion only**:

- First conversational completion with `successfulTools.size === 0` and no
  recovery spent → spend the single recovery, re-prompt stating the previous
  answer was unsupported and naming **only currently exposed** tools (never a
  withheld `run_check`), and run one more turn.
- Any subsequent completion still carrying no evidence → throw exactly today's
  `${role} task completed without repository tool evidence`.

Explicitly **terminal, with zero recovery**, unchanged from today: the Direct
tier; `CONTEXT_INSUFFICIENT`, which is an escalation and must not be retried;
fatal and provider errors; `kind: edit` without a validated patch artifact; and
`kind: command` without a successful `run_check`. None of these may be routed
through the generic recovery branch.

**Both conversational harnesses.** The producer Nanny path is the Pi SDK
harness. Pi disposes the session before `assertConversationEvidence` runs today,
so the recovery decision has to be made **while that same session is still
alive**, then issue exactly one further prompt and wait idle again. The legacy
harness needs equivalent behaviour. `assertConversationEvidence` is reached from
three call sites (approximately `utility-runtime.ts:1384`, `:1542`, `:1957`);
which of those are conversational, and which is Direct, must be established from
source before wiring, not assumed from the line numbers.

**The recovery turn continues the same run.** Same broker instance, same
definitions and active tools, same read and write scopes, same authority flags,
same timers, same rejection counters and tool budgets, same artifacts, same
cumulative usage and accounting. The counter is per job, fixed at one, and not
reachable from helper input.

## Producer fixture

`loop-fork/tests/fixtures/utility/run-151-scope-evidence/` holding, normalized
and with a `fixture-index.json` recording per-file SHA-256 and provenance:

- the `b649045c` job record and its empty tool-event stream;
- the `f155d583` job record, its tool-event stream through the successful
  `propose_patch`, and the three `run_check` rejections;
- the exact broker rejection messages, quoted.

## Order of work

RED first, as directed. Each regression is run against the unmodified base and
shown failing before any source change, and that failing output is captured under
`runs/utility-scope-evidence-recovery/artifacts/`.

1. Fixture and normalizer.
2. RED: `run_check is withheld when no declared cwd can satisfy it`.
3. RED: `a prose-only completion earns exactly one evidence-recovery turn`.
4. RED: `a second unsupported completion still fails closed`.
5. Implement A, then B — smallest change that turns each red green.
6. Focused, then governed verify, build, eval, clean scoped diff.

## Risks

- Withholding `run_check` changes the tool set a helper sees for file-scoped
  edits. Existing tests asserting its presence may need updating; any such change
  must be justified as intended, not silently adapted.
- The recovery turn costs one extra model round on a genuine prose-only answer.
  Bounded at one, and only on jobs that would otherwise have failed outright.
- Ordering matters: A alone would have saved job `f155d583`; B alone would have
  saved `b649045c`. Both are needed, and each regression must fail for its own
  reason, so the two are tested independently rather than through one scenario.

## Constraints carried from the directive

- No scope or authority widening; OSS approval stays advisory.
- Report worktree, branch, and this plan before implementation. **Done in this
  document; implementation has not started.**
- Stop at exact-SHA supervisor review.
- Install authority is granted only once supervisor and Codex jointly approve the
  exact candidate, so no install is run before that.
