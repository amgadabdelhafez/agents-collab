# D7 Governed Handoff Launch Identity

## Problem

At exact base `2c415e124c4cb2b39d81fa19a8e977e50dba48a9`, a governed handoff freezes
driver and reviewer effort but does not freeze the complete effective launch identity. The run
manifest does not persist the effective model selected for each agent. The handoff manifest digest
binds bundles, continuation text, efforts, and epoch, while replacement argv carries the agent pair
and efforts but no model identity. The replacement therefore resolves models again from ambient
environment or current defaults. Its acceptance record proves only handoff digest, replacement
session, and a newer epoch; it does not prove that the replacement actually launched with the
source models, workspace, topology, or source-run lineage.

That gap matches imported D7: run 191 changed Codex from `gpt-5.6-sol` at high effort to
`gpt-5.6-luna` at low effort during a late post-verdict handoff without a command authorizing the
transition. The frozen import cursor is
`/Users/amgad/harvto/docs/team/weeks/2026-W33.md` at SHA-256
`58e1ea1f28075e3c0634b7f4e1e51983a421ff9ae53dfaa37a4f4bac08399a90`, recorded in
`runs/harvto-supervisor-defects/artifacts/harvto-supervisor-drain.md`. The current external file is
new input at SHA-256 `b288bf1afdd5e3d9cea12b502abd35201bb345425acfd5a083e9d56798e94e49`;
its retained incident prose only corroborates the imported premise and does not replace or extend
the frozen source cursor.

## Required behavior

1. A paired run persists one normalized launch identity containing the exact agent topology,
   primary role, effective model for each participating agent, driver and reviewer efforts, cwd,
   workspace binding, repo identity, and run identity. In this repository, `Agent` is the supported
   provider/agent identity; D7 does not infer an unobservable downstream provider behind an
   agent-specific `auto` model. The shared normalized launch-identity type is declared and exported
   from `src/loop/run-state.ts`; `src/loop/types.ts` is not part of D7 scope.
2. Effective models come from the same resolver used to build the actual tmux agent commands.
   Reviewer-specific model overrides remain role-correct. A persisted value is the literal
   effective model, including `auto` when that is the selected contract; it is never recomputed
   from a later default and then represented as preserved.
3. A handoff snapshots the source launch identity and binds every field into the canonical handoff
   manifest digest. The identity includes the source `runId`, `repoId`, normalized workspace
   binding (`root`, `repoId`, and `branchRef`), source manifest identity digest, handoff epoch,
   primary and peer agents, per-agent effective models, and role efforts.
4. A normal handoff still launches a fresh loop with a fresh replacement run ID. “Preserve run
   identity” means the replacement durably records and accepts the exact source-run lineage and
   the parent binds acceptance to the exact replacement run/repo/manifest identity. D7 must not
   reuse the live parent run ID or weaken workspace ownership to force reuse.
5. Replacement launch uses the source cwd and passes every supported model override explicitly:
   primary or reviewer flags are selected according to the frozen agent roles, alongside the
   already-frozen effort flags. Claude's primary model is currently a fixed effective default with
   no primary-model CLI flag. Parent-side pre-spawn validation rejects a frozen Claude-primary
   value already known to be inexpressible by the current CLI/default contract. Drift in the
   replacement binary or its compiled Claude default cannot be proved by the parent and is rejected
   by replacement-side identity comparison before acceptance and before any parent teardown.
6. Before a replacement writes handoff acceptance, its own persisted launch identity must exactly
   match the digest-bound target identity and workspace binding. Acceptance records the source
   handoff digest plus the replacement run ID, repo ID, manifest identity digest, session, and
   newer Governess epoch. The parent may mark or kill the old loop only after reading that exact
   acceptance.
7. Missing, legacy-incomplete, malformed, stale, or tampered identity evidence fails closed for a
   governed handoff. Existing legacy manifests may remain readable for unrelated compatibility,
   but missing model or workspace identity may not authorize replacement launch or acceptance.
8. Any mismatch in agent roles, model, effort, cwd, workspace root/repo/branch, source lineage,
   handoff digest/epoch, replacement run/repo/manifest identity, or session prevents acceptance and
   old-loop teardown. Failure is durable and observable through the existing handoff launch-error
   or waiting path; it never silently falls back to defaults.
9. D7 adds no model-transition command or policy. A future explicitly authorized transition must
   name the target identity and bind it into the handoff digest; the current identity-preserving
   handoff cannot reinterpret an ambient environment change as authorization.
10. Restart and replay are idempotent. The same valid source manifest can produce one matching
    acceptance; a changed or replayed identity cannot authorize duplicate launch, mark, or kill
    effects.
11. Every byte change to any canonical D7 planning file invalidates the complete five-file
    SHA-256 set. After all planning edits stop, compute all five hashes together and re-derive them
    immediately before requesting one fresh Claude zero-write review of all five complete files
    against exact base `2c415e124c4cb2b39d81fa19a8e977e50dba48a9`; prior acceptance of unchanged
    sections or a delta-only review cannot satisfy this gate. A `REVISE`, partial verdict, wrong
    base or hash, silence, or any post-request planning edit voids the request and requires bounded
    planning-only correction, complete re-freeze, and another full review. On verdict receipt,
    re-derive all five hashes again and accept only literal `PLAN PASS` naming the exact base and
    all five current hashes before any source/test edit or red capture. Two consecutive `REVISE`
    verdicts on the same premise without convergence stop the loop and require supervisor
    escalation rather than a third re-freeze.

## Compatibility and boundaries

- D7 changes governed paired-tmux handoff identity only. It does not change ordinary headless
  review model selection, Governess judge models, utility provider routing, effort semantics, or
  downstream meaning of agent-specific `auto`.
- No live handoff, tmux teardown, provider call, Harvto mutation, remote write, dependency change,
  release, deploy, push, or merge is part of reproduction or verification. Tests use temporary
  manifests, injected launch dependencies, and deterministic argv inspection.
- The manually written old-epoch run-83 file is inert evidence only: live run-83 Governess state
  has `exitControl.mode="idle"` and no recognized bundles. D7 neither accepts nor deletes it.
- No UI behavior changes, so screenshot or DOM capture is not required.
- Production scope is `src/loop/tmux.ts`, `src/loop/run-state.ts`,
  `src/loop/paired-options.ts`, `src/loop/governess-handoff.ts`,
  `src/loop/governess-exit.ts`, and `src/loop/governess.ts`. Regression scope is
  `tests/loop/run-state.test.ts`, `tests/loop/paired-options.test.ts`,
  `tests/loop/governess-runtime.test.ts`, and `tests/loop/governess-exit.test.ts`. Planning,
  evidence, eval, Harness lifecycle, `PLAN.md`, and `status.md` are bookkeeping scope only.

## Acceptance

- The named exact-base regression feeds replacement argv through the real argument parser into
  `Options`, then calls the existing base-reachable `tmuxInternals.buildPairedAgentCommand`. Its
  decisive assertion reads the resolved effective Codex model from the returned launch argv. Under
  hostile ambient `gpt-5.6-luna`/low defaults, unchanged base must carry `gpt-5.6-luna` instead of
  the source `gpt-5.6-sol`; a direct missing-argv-token assertion is secondary only. No export,
  resolver extraction, or other `src/` byte change may precede red capture. Sharing the resolver
  for tmux launch and persisted identity is a post-red implementation step.
- Model persistence, role-correct argv, digest tamper rejection, fresh-run lineage, exact workspace
  binding, replacement acceptance, legacy/missing evidence, mismatch preservation of the old loop,
  restart, and replay controls pass.
- Focused tests and every mandatory repository/Harness gate pass with both evals reporting
  `baseline_failures: []` and an empty by-name allowlist.
- One bounded implementation commit receives Claude literal zero-write `PASS` for its exact SHA;
  Harness closes exactly once, followed by separate bookkeeping. D8 and later defects do not start
  before that boundary.
