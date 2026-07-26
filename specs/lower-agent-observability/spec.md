# Spec: Lower-Agent Observability

## Problem

The GLM utility tier is now executing work, but its useful runtime evidence is
split across JSONL journals. The governess board shows only the two frontier
agents and local judge usage, while the lower-agent pane shows one compact
latest-job line. An operator cannot see cumulative lower-agent calls, tool
calls, tokens, cost, failures, or the actual request/result exchange without
opening the run files manually.

## Goal

Make lower-agent activity legible while a loop is running. Add a compact
lower-agent metrics row to the governess board and turn the existing lower-agent
pane into a secret-safe live transcript of requests, tool activity, responses,
and failures. Preserve the headless worker and durable journals as the source of
truth.

## Requirements

1. Derive one read-only observability snapshot from `utility/jobs.jsonl`,
   `utility/usage.jsonl`, and `utility/tool-events.jsonl`; rendering must not
   affect routing or worker execution.
2. The snapshot reports queue/active/completed/failed counts, model calls, tool
   calls, input/cached/output/total tokens, cost, latest job, and latest route.
3. The governess pane includes a compact lower-agent row with state, model,
   job counts, cumulative tokens, model calls, tool calls, cost, and latest
   detail. Missing or disabled utility data renders safely instead of breaking a
   governess tick.
4. The lower-agent pane includes recent chronological transcript entries for:
   the main-agent request, each bounded tool call and its outcome, the worker
   response, and a failure blocker when present.
5. Transcript text is whitespace-normalized, terminal-control stripped,
   width-bounded, and line-capped. It must never display raw provider messages,
   API keys, raw tool output, or unrestricted trace bodies.
6. The pane continues to show current queue state, route reason, delegation
   counters, and worker availability.
7. Rendering remains useful in narrow panes and respects a deterministic row
   budget in tests plus live terminal height in the pane process.
8. Remove the governess Project / Objective / Progress / Next summary block
   from the board for now and dedicate that screen area to operational state.
   This is a display change; persisted summary state and routing behavior stay
   compatible.
9. Do not send input to, restart, or otherwise disturb the Claude and Codex
   panes. A live refresh may replace only the display-only lower-agent and
   governess panes after verification.
10. Do not push remotely.

## Acceptance criteria

- [x] Snapshot tests cover empty, completed, failed, and malformed/truncated
      journals and exact cumulative calls/tokens/cost.
- [x] Lower-agent pane tests show request, bounded tool outcome, response, and
      blocker entries with wrapping/truncation and control-character stripping.
- [x] Governess tests show one lower-agent metrics row with cumulative token,
      call, tool, cost, state, and job data.
- [x] The governess board no longer renders the structured Project / Objective /
      Progress / Next block and uses the recovered rows for operational state.
- [x] Existing lower-agent, governess, bridge, and tmux tests remain green.
- [x] `bun test`, `bun run build`, `git diff --check`, and `scripts/verify.sh`
      complete with any unrelated baseline failures isolated.
- [x] A different evaluator records `runs/lower-agent-observability/eval.json`
      before integration.
- [ ] If loop 46 is still active at release, Claude and Codex pane IDs/PIDs are
      unchanged after refreshing only the two display panes.

## Non-goals

- Showing raw chain-of-thought, provider HTTP payloads, secrets, or full tool
  output.
- Changing routing eligibility, worker prompts, budgets, or authority.
- Adding the utility worker as a third autonomous driver.
- Replaying old activity into either frontier agent TUI.
