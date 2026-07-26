# Task lower-agent-router

Created: 2026-07-26T02:10:41Z
Mode: planned
Description: Add an always-governess task router and bounded GLM-5.2 utility worker for cheap delegated subtasks

## What I changed

- Added provider-neutral route/tier/job/result types and fail-closed policy.
- Added append-only job storage with idempotency, epoch claims, and conflicts.
- Added bridge `route_task`, `task_status`, and `get_task_result` tools.
- Added governess-owned queue processing and detached utility workers.
- Added an OpenAI-compatible transport defaulting to OpenRouter GLM-5.2.
- Added bounded search/read/git/check/patch-proposal tools and redacted traces.
- Added compact result delivery plus an optional read-only utility tmux pane.
- Added main-agent prompt guidance and OpenRouter-inspired workspace policy.

## Why

Bounded repository work should consume cheap/local model tokens without making
the lower tier a third driver or giving it the paired agents' conversation,
authority, or unrestricted tools.

## Notes

- The default remote tier stays offline unless `OPENROUTER_API_KEY` or a
  protected utility key file exists.
- Local loopback endpoints can run without an API key.
- Utility edits are proposal-only in P0; a main agent reviews/applies patches.
- A fake OpenAI-compatible endpoint canary and a live routed GLM-5.2 canary
  pass.

## Safety review

The first independent review found command-argument escape, stranded-job,
evidence, write-claim, supervisor, and telemetry gaps. Those were closed with
canonical scoped paths, fail-closed claim deadlines, task-specific completion
evidence, active write claims, supervisor-only ingress, and durable tool/usage
events.

A second review found two deeper races: nonzero checks counted as evidence and
old workers could claim between governess epochs. Completion now requires a
zero-exit focused check, route decisions persist their epoch, activation is
monotonic under the utility-store lock, and claims require both route and active
epoch equality. The final independent re-audit is PASS.

## Verification

- Focused router/store/transport/tools/runtime/bridge suite: 192 pass, 0 fail.
- Governess integration suite: 68 pass, 0 fail.
- `bun run build`: pass.
- Ultracite on all new modules and tests: pass.
- Full `bun test`: 675 pass, 4 fail. The same four environment-sensitive Codex
  model/service-tier expectation failures reproduce in the unchanged base
  worktree and are unrelated to this slice.
- Full `bun run check`: blocked by pre-existing formatting/complexity findings
  in legacy source and prior run artifacts; targeted changed/new files pass.
- Root `scripts/verify.sh`: still a repository placeholder and performs no
  project verification.
- OpenRouter key `loop-utility-glm` has a $10 monthly cap and one-year expiry.
  Its secret is stored only in `~/.config/loop/openrouter.key` with mode 0600.
- Live routed GLM-5.2 canary: completed, 2 model calls, 1 scoped tool call,
  5,581 total tokens, and $0.0044160732 provider cost.
