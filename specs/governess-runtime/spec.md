# Spec: Governess Runtime

## Problem

The paired-loop supervisor still carries its former name in canonical surfaces, infers too
much state from tmux text, mixes observation with side effects, and has no
single durable protocol for control delivery, acknowledgement, fencing,
handoff artifacts, replay, or deterministic authorization.

## Goal

Rename the subsystem canonically to **governess**, then upgrade it into a
durable, replayable and fail-closed supervisor without losing the current live
board, recovery, quota, exit-menu or paired-agent behavior.

## Required capabilities

1. `governess` is the canonical CLI, environment, file, symbol, pane, state and
   documentation name. Legacy inputs may remain only as explicitly
   deprecated compatibility aliases at input/migration boundaries.
2. Agent integrations implement a runtime adapter contract for observation,
   control delivery, drain/exit requests, checkpoints and liveness. Tmux is a
   fallback adapter, not the domain model.
3. Agent and task lifecycle uses explicit states and monotonic event sequence
   numbers instead of treating pane hashes as authoritative state.
4. Governess control actions use a durable journal with idempotency keys,
   fencing epochs and delivery phases.
5. Graceful handoff is a durable teardown-first protocol: prepare/ready bundles,
   a manifest and continuation whose hashes validate, old-session teardown,
   then replacement launch/readiness acknowledgement. After a valid
   bundle and turn-end evidence exist, governess closes that drained agent TUI
   exactly once so handoff does not depend on the agent inventing its own exit
   mechanism. A Governess restart may advance its control-plane fencing epoch,
   but must preserve the epoch and exact validated artifacts of an in-flight
   handoff transaction.
6. Observation, deterministic policy, optional LLM triage and transactional
   execution are separate layers. LLM output cannot directly authorize a
   destructive action.
7. Driver ownership is a fenced lease. Stale governess incarnations cannot
   send controls, change roles or tear down sessions.
8. Stored events can be replayed without side effects, and a doctor command
   reports invariant, transport, runtime, state and replacement-session health.
9. Every action is classified as `observe`, `safe-automatic`,
   `require-confirmation`, or `forbidden` before execution.
10. The live board has one unified agent table: one header and exactly one row
    per agent. Runtime, quota, spend, token, activity and bridge signals are
    grouped into compact composite cells instead of repeating the agent rows in
    separate tables.

## Safety invariants

- Unknown runtime state, malformed probes, stale epochs and missing
  acknowledgements fail closed.
- No direct composer injection while an agent is active or its readiness is
  uncertain.
- No automatic commit, push, merge, deploy, destructive cleanup or timeout
  teardown.
- The old loop may be torn down only after every epoch-matching bundle, the
  manifest, and the continuation exist and all recorded hashes validate.
- Governess never closes an agent TUI before its epoch-matching ready bundle is
  validated and its turn has ended.
- A supervisor restart never rebinds persisted handoff bundles or their
  manifest to the new control-plane epoch.
- Every outbound control and external health probe is journaled with its
  decision, epoch and result.
- Existing dirty work is preserved.

## Acceptance criteria

- [x] Canonical rename is complete and compatibility aliases are isolated and
      tested.
- [x] Runtime adapters, explicit lifecycle state, journal, leases, policy,
      handoff and replay/doctor modules have focused tests.
- [x] The governess loop integrates those modules rather than leaving unused
      scaffolding.
- [x] Existing focused supervisor tests pass under canonical names.
- [x] Full tests and compiled build are run with unrelated failures recorded.
- [x] Independent evaluator returns PASS and `runs/governess-runtime/eval.json`
      exists.
- [x] Live deployment replaces only the governess pane and preserves both agent
      processes; destructive controls are not exercised live.
- [x] The board renders Claude and Codex once each under a single agent header,
      fits within 180 visible columns, and preserves the high-signal runtime,
      context, quota, spend, token, activity and bridge information.

## Non-goals

- AS DELIVERED FOR THIS FEATURE: adding more AI supervisor agents or a web dashboard. The separately planned browser projection is governed by `specs/webui-control-plane/`.
- Replacing the existing bridge transport wholesale.
- Removing compatibility aliases before a later deprecation release.
