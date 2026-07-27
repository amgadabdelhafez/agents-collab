# Tasks: Lower-Agent Router

## T-01 Protocol and routing

- Define participant, tier, capability, request, decision, job, and result types.
- Implement deterministic route gates and table-driven fixtures.
- Add route decision journaling and idempotency.

## T-02 Durable job store

- Persist append-only events and per-job request/result artifacts.
- Implement state transitions, epoch claims, conflict/file claims, and recovery.
- Add compact job/status readers for tools and governess rendering.

## T-03 Bridge and governess ownership

- Add P0 `route_task`, `task_status`, and `get_task_result` bridge tools.
- Defer guarded `apply_task_patch` and `cancel_task` to the next promotion slice.
- Process and claim route requests only from the current governess epoch.
- Return peer/main routes or utility results to the original requester.

## T-04 Utility worker

- Add a hidden worker subcommand and generic OpenAI-compatible transport.
- Configure GLM-5.2/OpenRouter defaults while supporting local endpoints.
- Implement bounded tool calls, redacted traces, usage/cost, timeout, and retry.

## T-05 Tools and micro-harness

- Add bounded search/read/status/diff/check/patch/result/escalation tools.
- Enforce protected paths, symlink containment, env scrubbing, output limits,
  preimage validation, and forbidden actions.
- Store patch/check artifacts and compact results.

## T-06 Prompts, panes, and telemetry

- Instruct both main agents when and how to call the router.
- Surface route and utility queue/model health in a compact top-right
  observation pane enabled for all new paired loops by default; persist
  token/cost/tool telemetry per job.
- Persist stable pane targets for main agents, governess, and utility instead
  of relying on fixed indexes.

## T-07 Evaluation

- Run routing, persistence, bridge, provider, tool-policy, and tmux tests.
- Run fake-provider and live-provider canaries.
- Verify both requester directions and supervisor present/absent.
- Record full verification and independent `eval.json`.
