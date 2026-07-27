# PROPOSED amendment to `specs/constitution.md`

> **Status: PROPOSAL. Not authoritative. Do not cite this file as a rule.**
> `specs/constitution.md` is a protected path under its own Prohibited-actions section
> ("Mutating protected paths without an approved spec"), so it has **not** been modified.
> This file carries the proposed replacement text plus the evidence for every line of it.
>
> To adopt: a human reviews Appendix A, replaces the body of `specs/constitution.md` with
> the text under "Proposed constitution text" below, appends an amendment log entry, and
> deletes this file.
>
> Author: docs remediation pass, 2026-07-27. Base commit: `cca7bef`.

---

## Why this proposal exists

`specs/constitution.md` has never been edited since `9dcc79e` ("Initialize agents collab
workspace"). Its Architecture-invariants section still reads:

```
_(Fill in your actual invariants. Examples below.)_
```

followed by four generic example bullets from the starter kit. Agents nonetheless cite
the constitution as authority — `CLAUDE.md` step 1 of the operating loop instructs them
to read it first on any new task. So the repo's most-cited authority currently ships a
fill-in-the-blank prompt and four rules that were never adopted.

This proposal replaces the placeholder with invariants **derived from what the repo
actually enforces**, and corrects three statements in the surrounding sections that
point at things which do not exist or are not in force.

### Rule followed while deriving

Per the brief: where an invariant could not be grounded in repo evidence, it was
**deleted, not invented**. Two of the four placeholder example bullets are dropped
outright for lack of evidence — see Appendix B.

---

## Summary of proposed changes

| # | Section | Change | Kind |
|---|---|---|---|
| 1 | Architecture invariants | Delete the `(Fill in your actual invariants…)` placeholder line. | removal |
| 2 | Architecture invariants | Replace the 4 example bullets with 10 invariants derived from `docs/architecture/system-overview.md` and the `specs/*/verify.md` acceptance contracts. | replacement |
| 3 | Quality bar | Add the named-baseline-failure rule (the repo's only executably-enforced rule). | addition |
| 4 | Quality bar | Mark the quality-scorecard gate **not in force** — `docs/quality/quality-scorecard.md` is still the shipped template. | correction |
| 5 | Agent operating rules | Add identity-only live verification (17 of 23 `verify.md` files require it). | addition |
| 6 | Agent operating rules | Add: features land through a separate `merge:` commit; the implementing agent does not merge. | addition |
| 7 | Prohibited actions | Fix the protected-path list — `docs/architecture/invariants.md` does not exist; the real file is `docs/architecture/system-overview.md`. | correction |
| 8 | Prohibited actions | Bind "skipping verification" to the commands that are actually the gate, since `scripts/verify.sh` is mostly `[CONFIGURE]` stubs. | correction |

Nothing in the existing constitution is deleted except the placeholder line and the two
unevidenced example bullets. Everything else is preserved or tightened.

---

## Proposed constitution text

<!-- BEGIN PROPOSED BODY — this is what would replace specs/constitution.md -->

# Constitution
> Non-negotiable rules. Everything else is advisory.
> Specs, plans, and tasks must not contradict anything here.

## Purpose

This document defines the permanent constraints for all work in this repo.
Agents and humans must read it before producing any spec, plan, or implementation.

---

## Quality bar

- No feature ships without a passing `eval.json` in `runs/<task-id>/`.
- No UI change ships without screenshot + DOM assertions in the eval.
- `baseline_failures` in an `eval.json` is an allowlist of **exact test names**. It is
  never a count and never a flag: `"baseline_failures": 4`, `"baseline_failures": true`,
  and the retired `"result": "pass_with_baseline_failures"` are invalid records. **The
  allowlist must be empty to release.** A named entry is a blocker to fix or waive
  explicitly; it is not a tolerance budget, and a task may not inherit another task's
  failures by matching a number.
- **(Not yet in force.)** No PR merges if `docs/quality/quality-scorecard.md` grades the
  touched subsystem as **D or F** without a remediation task tracked in `specs/`. This
  gate is suspended until the scorecard holds real subsystems — it currently ships the
  starter-kit template rows (`[e.g. Auth]`, `[e.g. Payments]`) and an empty
  `Last updated`. Do not cite a grade from it. Filling it in re-arms this rule.

## Architecture invariants

These are the invariants asserted in `docs/architecture/system-overview.md`. That file
and this one must not diverge; if a change makes one wrong, both change together.

- Paired tmux runs always have a governess. Its current epoch is required for a utility
  route and for a claim; a stale or missing epoch can neither claim nor dispatch a job.
- `Agent` is the full-agent lifecycle type. `utility` is only a bridge source and an
  execution tier — never a driver, a reviewer, or a recovery target.
- Provider latency cannot block governess ticks. Inference runs in a detached worker
  process; slow or failed provider calls do not delay the control loop.
- Agents, and the narrow Claude pre-tool policy, submit structured requests only. They
  cannot select a model, weaken route policy, or grant themselves new authority.
- Fail closed. Missing evidence, stale epochs, malformed journals, protected paths,
  traversal and symlink escapes, forbidden commands, and unknown risk are rejected, not
  guessed at.
- Utility edits are patch **proposals** in P0. Proposals carry preimage hashes, never
  modify the source, and are not applied automatically.
- Credentials stay in the provider process environment. They are removed from tool child
  environments, and are absent from prompts, traces, and artifacts.
- Pane availability and external-supervisor availability never determine job
  availability. An absent or disconnected external supervisor does not affect routing.
- Delegation is idempotent and durable: duplicate route submissions create at most one
  active job, and a worker crash or restart resumes or safely fails a durable job
  exactly once.
- External provider I/O is observable: the provider adapter records usage and a redacted
  trace, and route decisions, claims, and results are appended to the durable journal.
- `docs/dependency-map.md` must be accurate at time of merge.
- `loop-fork/src/loop/main.ts` stays under 150 lines.

## Agent operating rules

- Start from spec, not chat. `specs/<feature>/spec.md` is required before any
  implementation task.
- Worktree isolation is mandatory for every non-trivial task.
- The evaluator agent must be different from the implementation agent (no self-review).
- Live verification against a running loop is **identity-only**: record pane IDs and PIDs
  before and after and confirm they are unchanged. Do not send input to, restart, or
  signal a live agent pane. Destructive, timeout, and pane behaviour is proven with fake
  providers, fake PIDs, and disposable repositories and tmux sessions.
- The implementing agent does not merge its own work. A feature reaches the trunk through
  a separate `merge:` commit made by the supervisor.
- Replayable evals are required before any background maintenance agent is promoted to
  production. No task class moves from a main agent to a cheaper tier until replay or
  live evidence records success rate, main-agent rework rate, latency, actual cost, and
  estimated main-agent tokens avoided. Safety gates are never relaxed by model quality
  alone.

## Prohibited actions

- Broad permission grants (never `chmod 777`, never open network to `0.0.0.0` in
  production).
- Mutating protected paths without an approved spec. Protected: `specs/constitution.md`,
  `docs/architecture/system-overview.md`.
- Skipping verification to "save time." For changes under `loop-fork/`, verification is
  `bun test`, `bun run check`, `bun run build`, and `git diff --check`, plus the focused
  suites named in the feature's `verify.md`. `scripts/verify.sh` is the repo-level
  wrapper and enforces the baseline-failure allowlist; it is not by itself a substitute
  for the suite above while its lint/typecheck/test steps remain `[CONFIGURE]` stubs.

## Amendments

Amendments require a spec with human approval. Log changes at the bottom of this file
with date and summary.

---

_No amendments yet._

<!-- END PROPOSED BODY -->

---

## Appendix A — derivation of every invariant

Each row is the evidence that made the rule adoptable. Nothing below was reasoned from
outside this repo.

### Architecture invariants

| Proposed invariant | Evidence |
|---|---|
| Governess epoch required for route + claim | `docs/architecture/system-overview.md` § Architecture invariants, bullet 1; `specs/lower-agent-router/verify.md` — "A stale or missing governess epoch cannot claim or dispatch a job." |
| `utility` is never driver/reviewer/recovery target | `docs/architecture/system-overview.md` § Architecture invariants, bullet 2; `docs/architecture/system-overview.md` § Responsibilities, "Utility worker … Does not own: Human communication, main-agent roles, commits or deployment" |
| Provider latency cannot block governess ticks | `docs/architecture/system-overview.md` bullet 3; `specs/lower-agent-router/verify.md` — "Slow/failed provider calls do not delay governess ticks." |
| Agents cannot select a model or grant authority | `docs/architecture/system-overview.md` bullet 4; `specs/lower-agent-router/verify.md` — "Utility requests contain only explicit job context and selected artifacts." |
| Fail closed on missing/stale/malformed/protected/unknown | `docs/architecture/system-overview.md` bullet 5; `specs/lower-agent-router/verify.md` — "Traversal, symlink escape, protected paths, secret paths, shell interpolation, forbidden commands, and oversized output are rejected."; commit `39e479b` "widen delegation classifier with fail-closed hardening" |
| Utility edits are patch proposals with preimage hashes, P0 | `docs/architecture/system-overview.md` bullet 6; `specs/lower-agent-router/verify.md` — "Patch proposals include preimage hashes and never modify the source." / "Guarded patch application remains disabled in P0." |
| Credentials confined to the provider process | `docs/architecture/system-overview.md` bullet 7; `specs/lower-agent-router/verify.md` — "Provider credentials are absent from prompts, traces, artifacts, and tool child environments."; `.claude/skills/risk-review/skill.md` BLOCK condition "Credentials or secrets found in diff." |
| Pane / external-supervisor availability never gates jobs | `docs/architecture/system-overview.md` bullet 8; `specs/lower-agent-router/verify.md` — "External supervisor absence/disconnect does not affect routing."; § System map — "An external bridge supervisor can submit/observe messages, but is not a route or claim authority." |
| Idempotent, exactly-once durable jobs | `specs/lower-agent-router/verify.md` — "Duplicate route submissions create at most one active job." and "Worker crash/restart resumes or safely fails durable jobs exactly once."; `docs/architecture/system-overview.md` § Responsibilities, "Utility job store: Idempotent append-only requests, decisions, claims, results" |
| Provider I/O observable; decisions journaled | `docs/architecture/system-overview.md` § Responsibilities, "Provider adapter … usage/cost, redacted trace"; § Key data flows 2 and 4; `specs/lower-agent-router/verify.md` — "Usage contains model, prompt/output/reasoning tokens, tool rounds, latency, provider cost…"; `.claude/skills/risk-review/skill.md` step 4, "New external I/O without trace spans." |
| Dependency map accurate at merge | `.claude/skills/risk-review/skill.md` step 2 (cross-reference the map) and step 4 ("Changes to protected paths…"); `.github/agents/docs-gardener.agent.md` § 1 freshness check; `CLAUDE.md` context-engineering rule. The map is genuinely maintained — `docs/dependency-map.md` reads "Last updated: 2026-07-26" with real module rows. |
| `main.ts` under 150 lines | `loop-fork/AGENTS.md` line 1 — "keep the `src/loop/main.ts` file under 150 lines of code"; `specs/governess-pane/verify.md` F-11 — `test $(grep -c "" loop-fork/src/loop/main.ts) -lt 150` |

### Quality bar and operating rules

| Proposed rule | Evidence |
|---|---|
| Named baseline-failure allowlist, must be empty to release | `scripts/check-baseline-allowlist.py` (executable enforcement — rejects counts, flags, and the retired result string); `scripts/verify.sh` step 7 invokes it; `specs/_template/verify.md` § Baseline failures; `.claude/skills/risk-review/skill.md` BLOCK condition; commit `cca7bef` |
| Quality-scorecard gate suspended | `docs/quality/quality-scorecard.md` still contains the template rows `[e.g. Auth]`, `[e.g. Payments]`, `[e.g. Data pipeline]`, `[e.g. Admin UI]`, a debt register row `D-001 [Subsystem] [What is wrong]`, and `Last updated: <!-- YYYY-MM-DD -->`. There is no real grade to gate on. |
| Identity-only live verification | 17 of the 23 `specs/*/verify.md` files require unchanged pane IDs/PIDs. Explicit statements: `specs/lower-agent-release-integration/verify.md` — "Live-loop verification is identity-only … Do not send input or restart a process."; `specs/lower-agent-hardening/verify.md` — "Use fake providers, fake PIDs, and disposable repositories/tmux sessions"; `specs/governess-runtime/verify.md` § Live, non-destructive |
| Implementer does not merge | 38 commits in `git log` use the `merge:` prefix and are separate from the `feat:`/`fix:`/`docs:` commit they land (e.g. `ac1d37d merge: remove worker step budget` following `c23d831 feat(loop): remove worker step budget`). `specs/codex-bridge-visible-tui/spec.md` records an incident where an agent "continued past supervisor stop rulings", i.e. a supervisor authority exists above the agents. |
| Promotion gate for cheaper tiers | `specs/lower-agent-router/verify.md` § "Long-term promotion gate", quoted near-verbatim. |
| Protected-path correction | `docs/architecture/invariants.md` does not exist (`ls` returns "No such file or directory"); `docs/architecture/` contains only `system-overview.md`, which is where the real § Architecture invariants lives. |
| Verification-skipping correction | `scripts/verify.sh` lines 13–36: lint, typecheck, unit, and integration all print `[CONFIGURE: add … command]` and run nothing. The only executable gate is step 7's allowlist check. 20 of 23 `verify.md` files run `bun test`; 16 run `git diff --check`. |

---

## Appendix B — placeholder bullets deliberately NOT carried forward

Two of the four starter-kit examples had no support anywhere in the repo. Per the
brief, they are deleted rather than invented into rules.

| Dropped example | Why |
|---|---|
| "Services must not import directly across bounded-context boundaries; use declared interfaces." | No import rule exists anywhere: not in `docs/architecture/system-overview.md`, not in any `verify.md`, not in `risk-review`, not in lint config. The repo has a Responsibilities/ownership table, which is a different thing from an import restriction, and it is already captured by the fail-closed and authority invariants. No evidence → no rule. |
| "No secrets in source. Credentials are proxied through the secrets layer, never accessed directly by agents." | The *intent* is real and is retained, but **there is no "secrets layer" in this repo.** The actual mechanism is process-environment confinement: credentials live in the provider process environment and are stripped from tool child environments and traces. The proposed text states the real mechanism. Carrying the original wording forward would have sent agents looking for a component that does not exist. |

Two were retained, both narrowed to what is provable:

| Retained example | How it was narrowed |
|---|---|
| "All external I/O is observable: every outbound call must emit a trace span." | Narrowed to provider I/O plus journaled route/claim/result events, which is what the code and the verify contracts actually assert. "Every outbound call" and "trace span" (an OpenTelemetry term with no implementation here) were not provable. |
| "The dependency map must be accurate at time of merge." | Kept as-is. It is the one example bullet with three independent supporting sources. |

---

## Appendix C — related drift found while deriving, NOT changed here

Out of scope for a constitution amendment, but recorded so it is not rediscovered:

1. `evals/{smoke,regression,replay,skills}` are **empty directories**, while
   `evals/README.md` documents a four-tier harness and the constitution requires
   "replayable evals … before any background maintenance agent is promoted". The
   requirement currently has no harness to satisfy it.
2. `specs/delegation-grammar-widening/verify.md` ("the full suite's only failures are the
   4 known baseline Codex-launch failures"), `specs/utility-hook-worktree-recovery/verify.md`
   ("compared with the known four-failure baseline"), `specs/worker-token-bridge-row/verify.md`,
   `specs/worker-pane/verify.md`, and `specs/lower-agent-router/verify.md` still permit a
   counted baseline. That is exactly the tolerance `cca7bef` retired. These files should
   be reconciled with the named-allowlist rule.
3. `.agents/skills/risk-review/skill.md` is stale against `.claude/skills/risk-review/skill.md`
   — it is missing the baseline-allowlist BLOCK condition added in `cca7bef`. The other two
   mirrored skills are byte-identical.
4. `docs/testing/commands.md` is still entirely `[your-unit-test-command]` placeholders,
   while `AGENTS.md`'s "Where truth lives" table advertises it as the authoritative list.
5. No hooks are configured in this repo (`.claude/settings.json` absent;
   `.claude/settings.local.json` holds only a permissions allowlist), yet `CLAUDE.md`
   described five hooks as "deterministic — always run". This has been corrected in
   `CLAUDE.md` on the same branch as this proposal.
6. 4 of the 19 historical `runs/*/eval.json` files fail the new gate today:
   `worker-unbounded-steps`, `bridge-single-delivery`, `utility-worker-pool`, and
   `bridge-idle-delivery` all record `"baseline_failures": true` and/or the retired
   `pass_with_baseline_failures` result. They are historical records rather than release
   gates, so no rewrite is proposed here, but anyone re-running `scripts/verify.sh`
   against those task-ids will get a red gate.
