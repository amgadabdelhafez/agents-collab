# Plan: Lower-Agent Router

1. Separate full agents from bridge participants, route targets, execution
   tiers, and capability policies.
2. Add a durable route/job store with idempotency, state transitions, compact
   artifacts, file claims, and epoch-fenced claim semantics.
3. Add a pure fail-closed router and a structured bridge `route_task` tool.
   Model the workspace policy after the useful OpenRouter controls: allowed
   model/tier patterns, cost-quality preference, locked defaults, selection
   strategy, and an explicit fallback.
4. Have governess process pending route requests and start/observe the utility
   worker without awaiting provider work in its tick.
5. Add a generic OpenAI-compatible client, GLM-5.2 configuration, usage/cost
   accounting, and bounded tool loop.
6. Add inspection, focused-command, patch-proposal, result, and escalation tools
   with strict policy enforcement.
7. Deliver compact results to the original requester and add delegation prompt
   guidance for both main agents.
8. Add a default read-only utility pane at the top-right above the right main
   agent, with an explicit environment opt-out. Persist pane targets so the
   worker remains headless and bridge/governess routing is layout-independent.
9. Verify with deterministic routing fixtures, a fake provider, a live provider
   canary when credentials exist, full tests/build/check, and independent eval.
10. Expand utility eligibility only after measuring completion, rework, latency,
    cost, and main-agent token displacement on replayable task classes.
