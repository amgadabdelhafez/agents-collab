# Harvto Supervisor Defect Campaign

## Problem

The Harvto supervisor recorded repeated control-plane failures during paired-agent work. The reports are evidence leads, not assumed current defects. Each lead must be reproduced against this worktree's `origin/main` baseline or closed with exact evidence showing the invariant already holds.

Evidence sources are read-only:

- `/Users/amgad/harvto/docs/team/backlog.md`
- `/Users/amgad/harvto/docs/team/weeks/2026-W33.md`
- `/Users/amgad/harvto/STATUS.md`

## Required outcomes

1. Produce a durable defect matrix mapping each report to current code, a regression test, and one of `fixed`, `already-fixed`, `duplicate`, or `not-reproduced`.
2. Fix every confirmed in-scope regression in the priority order below.
3. Make absence of delivery, routing capacity, liveness, or completion evidence fail closed rather than appear healthy.
4. Preserve paired Claude/Codex behavior, exact run identity, and reviewer zero-write isolation.

## Priority groups

### P0: delivery and launch truth

- Bridge deliveries delayed until TTL expiry or dead-letter despite a live intended peer.
- Routed peer messages remain unconsumed while that peer is live.
- Launch races leave legacy manifest ghosts or a crashed start represented as live.

### P1: routing and completion truth

- `route_task` accepts work when no eligible utility tier can claim it, leaving `pending-route` indefinitely.
- An agent completes a bounded task without a durable supervisor-visible close signal.

### P2: recovery fidelity

- A read-only tmux attachment prevents safe targeted recovery delivery.
- An uncommanded Codex handoff changes model or effort.
- A stale utility edit lease permits writes after the lease is no longer authoritative.

## Acceptance principles

- A test must exercise the failed branch, not merely assert a happy-path counter.
- Liveness must be derived from the exact manifest-recorded tmux target and positive process/pane evidence.
- Delivery recovery must preserve idempotency and must not silently discard or duplicate messages.
- Routing must reject or durably fail a job when no eligible worker exists; it may not remain pending forever.
- Completion must be durable and attributable to the exact run/task/SHA.
- Handoffs must preserve configured provider, model, effort, workspace, and run identity unless an authorized transition explicitly changes them.
- Source code changes should remain narrow. Reports that share one root cause should have one fix and multiple regression cases.

## Boundaries

- Do not edit the Harvto repository.
- Do not resume or mutate preserved Harvto loop runs.
- Do not merge, rebase, push, install a global binary, deploy, spend, or change providers/models.
- Do not inject `/compact` or `/rename` into any live agent.
- Do not weaken release authority or make the OSS utility seat authoritative for release.
- Keep `src/loop/main.ts` under 150 lines.

