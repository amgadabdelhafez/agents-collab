# Spec: Utility scope-satisfiable capabilities and bounded evidence recovery

## Problem

Two run-151 helper jobs failed closed for reasons that were the harness's fault,
not the model's. Both wasted a routed job; one discarded work the helper had
already completed correctly.

Producer evidence, `/Users/amgad/.loop/runs/harvto-b1e274e66299/151/utility/`.

### Defect A — an unsatisfiable tool was exposed

Job `f155d583-0d10-4b41-a0e4-77cf47c67776`, Au Pair, `kind: edit`, routed with
read and write scope both exactly one file:
`03-Development/ar-prototype/scripts/loop75-enrollment-harness.mjs`.

From `tool-events.jsonl`, the helper did the work: nine successful `read_file`
calls, two successful `search_repo` calls, then at `06:12:07.812Z` a **successful
`propose_patch`** producing artifact
`e4d7c9c2-e9b2-4d83-bf9e-c2e7d93d8046.patch`
(sha256 `761c6f6d4aba4c41d4a507851347fc4e4fea512c57cabffca4ad08875bbe6841`).

It then tried to run a check three times and was rejected each time:

```
06:12:10.354Z run_check scope_denied  Command cwd is outside its exact declared scope: .
06:12:11.577Z run_check path_denied   Path must be repository-relative: /private/tmp/harvto-loop145-base
06:12:12.597Z run_check scope_denied  Command cwd is outside its exact declared scope: .
```

Three consecutive broker rejections tripped `MAX_CONSECUTIVE_BROKER_REJECTIONS`
(`utility-runtime.ts:1626`) and the job failed closed, **discarding the valid
patch**.

Root cause, `loop-fork/src/loop/utility-tools.ts`:

- `:1271` `this.commandCwds = (config.commandCwds ?? config.readScopes).map(...)`
- `:1274` `this.commandCwdsAreExact = config.commandCwds !== undefined`
- `:2013-2022` `resolveCommandCwd` denies unless the requested cwd is in
  `commandCwds`, and then requires it to resolve to an existing directory.

With no explicit `commandCwds`, the fallback is `readScopes`. When every read
scope is a **file**, no value can satisfy both conditions at once: a file path is
in scope but is not a usable working directory, and the repo root is a directory
but is out of scope. **The satisfiable-cwd set is empty, yet `run_check` is
still exposed** (`describeCapabilities`, `:1317`), so the model is offered a tool
it cannot possibly call correctly and burns its rejection budget discovering
that.

### Defect B — no bounded evidence-recovery turn

Job `b649045c-c0c0-4f7c-a4a0-b2220ae67af4`, Nanny, `kind: inspect`,
`executionProfile: search`, `readScope: ["03-Development"]`, model
`qwen3.6-35b-a3b-vl`. It recorded **zero** entries in `tool-events.jsonl` and
failed at `06:01:56.979Z`, 3.4 s after starting, with
`Nanny task completed without repository tool evidence`.

`search_repo` was exposed and satisfiable. The model simply answered in prose
without calling it. `utility-runtime.ts:1274-1276` throws the moment
`successfulTools.size === 0`, with no opportunity to correct:

```ts
if (successfulTools.size === 0) {
  throw new Error(`${role} task completed without repository tool evidence`);
}
```

A prose-only first completion is a recoverable model slip. Today it is terminal.

## Goal

A routed helper job fails closed only for reasons the helper could have avoided.
Capability maps offer only tools the job's own scopes can satisfy, and a single
prose-only completion gets one bounded chance to produce real evidence before the
job is failed.

## Requirements

1. **`run_check` is withheld when no declared cwd can satisfy it.** The claim is
   deliberately narrow: this task establishes satisfiability filtering **for
   `run_check` only**. It does not claim, and must not be worded to imply, that
   every broker tool is satisfiable for every argument shape. A general per-tool
   satisfiability registry would need its own coverage and is out of scope here.
2. **Satisfiability reuses the execution policy, it does not restate it.** The
   derivation must go through the same canonical cwd path as enforcement:
   `normalizeRequestedPath`, the exact-vs-prefix semantics selected by
   `commandCwdsAreExact`, `realpath` plus repository containment, the protected
   path check, and directory existence. Creating a second, looser predicate that
   could disagree with `resolveCommandCwd` is the failure mode to avoid.
3. **Satisfiability is a broker-creation-time snapshot.** It is computed once
   when the broker is built. Later filesystem drift may only ever cause a call
   to fail closed at execution time; it must never retroactively widen exposure.
4. **Every exposure surface agrees.** The actual tool `definitions` (and the Pi
   active-tool set), `describeCapabilities().tools`, the advertised command
   prefixes, and the denial and helper-guidance strings must all reflect the same
   withholding decision. A tool withheld from one surface and advertised on
   another is the same defect in a new place.
5. **One bounded evidence-recovery turn**, and only for the generic
   evidence-free conversational completion. When a conversational completion
   carries no repository tool evidence, the helper gets exactly one additional
   turn, told that its answer was unsupported and which currently exposed tools
   would supply evidence.
6. **A second unsupported completion still fails closed**, with today's error and
   today's terminal behaviour. The budget is fixed at one and is not reachable
   from helper input.
7. **Recovery does not apply to these, which stay terminal exactly as today:**
   the Direct tier; `CONTEXT_INSUFFICIENT`, which is an escalation and must not
   be retried; fatal and provider errors; `kind: edit` completing without a
   validated patch artifact; and `kind: command` completing without a successful
   `run_check`. None of these may be routed through the generic recovery branch.
8. **Both conversational harnesses implement it.** The producer Nanny path is the
   Pi SDK harness; the legacy harness needs equivalent behaviour. In the Pi path
   the recovery decision must be made **while the same session is still alive**,
   since the session is disposed before the evidence assertion today.
9. **The recovery turn continues the same run, it does not start a new one.** The
   second turn must reuse the same broker instance, the same definitions and
   active tools, the same read and write scopes, the same authority flags, the
   same timers, the same rejection counters and tool budgets, the same artifacts,
   and the same cumulative usage and accounting.
10. **No scope or authority widening**, and the recovery prompt may name only
    currently exposed tools — never a withheld `run_check`.
11. **Existing fail-closed paths are otherwise unchanged**, including
    `MAX_CONSECUTIVE_BROKER_REJECTIONS`.
12. **OSS approval remains advisory.** Nothing here grants release authority.
13. **Producer-backed RED regressions.** Coverage replays the two checked-in
    run-151 job shapes, and every regression is shown failing on the unmodified
    base before the fix lands.

## Scope

- `loop-fork/src/loop/utility-tools.ts` — `run_check` satisfiability derivation,
  reusing the execution cwd policy, applied to every exposure surface.
- `loop-fork/src/loop/utility-runtime.ts` — bounded evidence-recovery turn in
  both conversational harnesses, Pi SDK and legacy.
- Checked-in producer fixture derived from run-151 job and tool-event records.
- Named regressions plus the governed verify entry.
- No routing, Governess policy, launcher, or bridge change.

## Non-goals

- Making `run_check` work for file-only scopes by inferring a parent directory.
  That would widen scope; withholding the tool is the correct direction, and
  Codex confirmed it (`0a27f1ab-9e4f-4522-a70a-aea69aeff0a3`).
- A general per-tool satisfiability registry covering every broker tool. This
  task narrows to `run_check`; a registry would need its own coverage.
- Recovery for Direct, for `CONTEXT_INSUFFICIENT`, or for the edit and command
  evidence assertions.
- Changing `MAX_CONSECUTIVE_BROKER_REJECTIONS`.
- Any change to the Claude kickoff submit guard, which is a separate release
  candidate at `951ea73eb1ab00a2677c3cf93eeeb080daf8f211` and must not be mixed
  into this branch.
