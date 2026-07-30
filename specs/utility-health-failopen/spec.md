# Spec: Utility Health Fail-Open

## Problem

Automatic `PreToolUse` delegation currently denies the main agent's original
tool call when the Au Pair is merely configured. It does not verify that the
Governess dispatcher is still advancing, does not select the actual execution
tier before checking readiness, and treats Nanny's loopback MLX endpoint as
healthy without evidence that an inference completed. A wedged MLX generation
thread or stale Governess can therefore turn automatic delegation into a queue
of jobs that nobody can serve while the main agent is repeatedly denied.

## Goal

Make automatic delegation conditional on a fresh dispatcher lease and recent
successful inference evidence for the selected model tier. When either signal
is missing, stale, or failed, preserve the original main-agent tool call and
record a compact reason. Keep explicit helper requests available as bounded
health probes, but open a short circuit after a real provider failure.

## Requirements

1. Determine Direct, Nanny, or Au Pair from the fully normalized route request
   before deciding whether a hook may deny the original tool.
2. Treat `governess-state.json` as a dispatcher lease only when its epoch
   matches `utility/epoch` and its file timestamp is no more than 45 seconds
   old. Missing, malformed, mismatched, or stale evidence fails open.
3. Treat recent successful model completion, not `/health`, `/v1/models`, a
   loopback URL, or credential presence, as model readiness. Read only a
   bounded tail of the Governess MLX trace and helper usage ledger.
4. Direct broker work needs a fresh dispatcher but no model inference lease.
   Nanny and Au Pair need both configuration readiness and a successful
   selected-tier inference no more than five minutes old before automatic
   delegation can deny the original tool.
5. A selected-tier failure newer than its last success opens a one-minute
   routing circuit. During the circuit, explicit requests return through the
   ordinary fail-closed router instead of spawning another model worker.
   Unknown or expired evidence may admit an explicit bounded probe, but never
   an automatic denial.
6. Record secret-safe reasons such as `dispatcher-stale`,
   `inference-unknown`, `inference-stale`, and `inference-failed`; never record
   prompt bodies, responses, credentials, or unbounded output.
7. Fix the redraw smoke's startup race by waiting for the Governess journal to
   exist before assertions that depend on it.
8. Do not restart the live Nanny or Au Pair. Activate the already deployed
   redraw binary only by respawning the Governess pane at a zero-active-job
   boundary, preserving Claude, Codex, helper, and recon panes.
9. Do not push remotely.

## Acceptance criteria

- [ ] Hook tests prove fresh Direct and model-tier routes deny, while missing,
      stale, epoch-mismatched, unknown, and failed readiness preserve the
      original call with a compact telemetry reason.
- [ ] Runtime tests prove a recent model failure opens the selected tier's
      circuit and that unknown/expired state remains probeable explicitly.
- [ ] Tests prove Nanny readiness comes from real MLX completion evidence and
      not a green loopback endpoint.
- [ ] The redraw smoke is stable across six consecutive runs.
- [ ] Focused tests, full `bun test`, `bun run build`, `git diff --check`, and
      `scripts/verify.sh` pass or isolate a pre-existing baseline failure.
- [ ] `runs/utility-health-failopen/eval.json` records the exact checks before
      integration.

## Non-goals

- Synchronous provider probes from a latency-sensitive hook or Governess tick.
- Expanding helper authority, write scope, tools, concurrency, or budgets.
- Restarting the main agents, helper workers, recon panes, or tmux server.
- Trusting HTTP liveness endpoints as inference readiness.
