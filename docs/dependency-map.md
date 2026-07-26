# Dependency Map

Last updated: 2026-07-26

## Modules

```text
[CLI and tmux]
  owns: src/cli.ts, src/loop/tmux.ts
  exposes: paired panes and hidden bridge/governess/utility subcommands
  consumes: run state, bridge config, governess, utility runtime

[Bridge]
  owns: src/loop/bridge*.ts
  exposes: send_message, route_task, task_status, get_task_result
  consumes: bridge JSONL, utility job API, runtime delivery adapters

[Delegation policy]
  owns: delegation-policy.ts, Claude PreToolUse integration, Codex proxy observation
  exposes: exact mechanical classifier and compact adoption telemetry
  consumes: run manifest, utility job API, app-server item notifications

[Governess]
  owns: src/loop/governess*.ts
  exposes: fenced control and route-processing loop
  consumes: pane/hooks/usage evidence, bridge, utility routing controller

[Utility control]
  owns: task-router.ts, utility-store.ts, utility-runtime.ts
  exposes: pure route decision, durable jobs, detached worker and pane view
  consumes: bridge dispatch, provider adapter, tool broker

[Provider adapter]
  owns: openai-compatible.ts
  exposes: bounded chat/tool transport with redacted trace and usage
  consumes: configured HTTPS or localhost OpenAI-compatible endpoint

[Utility tool broker]
  owns: utility-tools.ts
  exposes: search/read/status/diff/check/patch-proposal tools
  consumes: declared repository scopes and literal allowlists
```

## Dependency graph

```text
main agents ──MCP──► bridge ──append──► utility store
    │                                  ▲
    ├─ Claude exact PreToolUse ────────┤
    └─ Codex app-server observation ──► delegation telemetry
                                  ▲           │
                                  │           ▼
governess ──route/epoch───────────┴────► task router
    │                                         │ eligible
    └──────────── spawn detached ─────────────▼
                                         utility worker
                                         ├─► provider adapter ──HTTPS──► OpenRouter/local endpoint
                                         ├─► tool broker ──argv/fs──► scoped repository
                                         └─► bridge ──compact result──► requester

optional utility pane ──read only──► utility store
optional bridge supervisor ──messages/route request──► bridge
```

## Cross-cutting concerns

| Concern | Owner | Evidence |
|---|---|---|
| Route authority | Governess epoch + task router | `governess.jsonl`, utility `jobs.jsonl` |
| Secrets | Provider adapter and tool env scrubber | redacted `utility/llm-trace.jsonl` |
| Background jobs | Utility store/runtime | `utility/jobs.jsonl`, stale-claim fencing |
| Cost and tokens | Provider adapter/runtime | `utility/usage.jsonl` |
| Delegation adoption | Delegation policy, hook, and Codex proxy | `utility/delegation.jsonl` |
| Large outputs | Tool broker | patch/report artifacts referenced by result |
| Visibility | Governess and optional utility pane | pane output; never a control dependency |

## Blast-radius guide

| If you touch… | Also check… | Why |
|---|---|---|
| Bridge tool schema | Agent MCP config, bridge tests, prompt guidance | Both agents consume the public tool contract |
| Route/job types | Router, store replay, runtime and bridge utility adapter | Durable events must remain materializable |
| Governess epoch/loop | Utility claims, stale recovery, liveness tests | It is the single route authority |
| Tool broker | Worker prompt, scope tests, secret/command policy | This is the host security boundary |
| Provider adapter | Retry/redaction/usage tests and fake canary | External I/O must remain bounded and observable |
| Tmux layout | Pane identity, manifest assumptions, tmux tests | Existing code still has positional pane assumptions |
| Hook or Codex proxy | Delegation classifier, telemetry, bridge prompts | Claude can enforce pre-tool; Codex is observation-only until a supported per-tool hook exists |
