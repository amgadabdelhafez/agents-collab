# lower-agent-router Research

## Research Question

What existing repo primitives and OpenRouter/OpenAI-compatible patterns can be
reused to route bounded subtasks to a cheaper model without adding a second
scheduler, leaking full-agent context, or giving the model broad host authority?

## Candidates Reviewed

- Existing loop bridge (`bridge-store.ts`, `bridge-dispatch.ts`,
  `bridge-runtime.ts`): already provides a durable JSONL envelope, task/thread
  metadata, priorities, TTL, dedupe, acknowledgements, and asynchronous agent
  delivery. Reuse for ingress and compact result delivery, but do not overload
  its transport worker as a task executor.
- Existing governess runtime and journal: already owns a fenced epoch, driver
  lease, deterministic action policy, replayable controls, and health board.
  Reuse as the only routing/claim authority; keep model/tool execution outside
  its watchdog tick.
- OpenRouter Chat Completions and tool calling: OpenAI-compatible request and
  response shapes with client-executed function calls and response usage/cost.
  Use raw `fetch` to avoid a new runtime dependency and to support local
  OpenAI-compatible endpoints later.
- OpenRouter Responses API server tools: rejected for this slice because the
  local host must validate paths, commands, patch preimages, and environment
  access before any effect.
- Full third-agent CLI (Claude/Codex-style harness): rejected because it would
  duplicate session/harness context and accidentally entangle the utility tier
  with primary/reviewer/driver lifecycle semantics.
- OpenRouter workspace Routing UI: borrowed its provider-independent concepts,
  not its control plane. The observed controls were wildcard allowed-model
  patterns, a 0-10 quality-to-cost preference, prevention of per-request
  overrides, provider sorting by balanced/price/throughput/latency/tool-call
  quality, and a default fallback model. In loop-fork these become tier policy
  owned by governess rather than request-time model choice owned by agents.

## Open-Source Patterns

- Separate control plane from execution workers: the scheduler owns durable
  claims and retries, while workers consume bounded jobs and report artifacts.
- Route by capabilities and risk rather than model/vendor name so tiers can be
  replaced or expanded without rewriting orchestration.
- Let models propose tool calls; execute tools client-side through a policy
  broker with path, command, time, output, and cost limits.
- Keep task context explicit and artifact-backed instead of forwarding the
  entire parent conversation.
- Use idempotent append-only events plus compact state snapshots for crash
  recovery and replay.

## Reuse Decision

Adapt the existing bridge and governess primitives. Build a small pure router,
utility job store, generic OpenAI-compatible transport, and bounded tool broker
inside the current single-binary architecture. Do not add an agent framework or
SDK dependency. Keep provider configuration generic, with OpenRouter GLM-5.2 as
the first configured tier and localhost-compatible endpoints as a supported
future path.

## Sources

- https://openrouter.ai/workspaces/default/routing
- https://openrouter.ai/z-ai/glm-5.2
- https://openrouter.ai/docs/guides/features/tool-calling
- https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request
- https://openrouter.ai/docs/guides/routing/provider-selection
- https://openrouter.ai/docs/cookbook/administration/usage-accounting
- https://openrouter.ai/docs/guides/features/guardrails/overview
