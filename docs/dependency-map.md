# Dependency Map

Last updated: 2026-08-20

## Modules

```text
[CLI and tmux]
  owns: src/cli.ts, src/loop/tmux.ts
  exposes: paired panes and hidden bridge/Governess/Nanny/Au Pair subcommands
  consumes: run state, bridge config, governess, utility runtime

[Bridge]
  owns: src/loop/bridge*.ts
  exposes: send_message, route_task, task_status, get_task_result, request_native_fallback, native_fallback_status
  consumes: bridge JSONL, utility/native-fallback journals, runtime delivery adapters

[Delegation policy]
  owns: delegation-policy.ts, Claude/Codex PreToolUse integration, Codex proxy observation
  exposes: exact mechanical classifier, utility adoption, native-spawn gating, and compact telemetry
  consumes: run manifest, hook cwd and literal shell workdir, verified Git worktree identity, utility/native-fallback APIs, app-server item notifications

[Governess]
  owns: src/loop/governess*.ts
  exposes: fenced control, route processing, and native-fallback lease decisions
  consumes: pane/hooks/usage evidence, bridge, utility routing controller, native-fallback journal

[Utility control]
  owns: task-router.ts, utility-execution-tier.ts, utility-store.ts, utility-context.ts, utility-runtime.ts
  exposes: pure Direct/Nanny/Au Pair decision, durable one-owner jobs, immutable context capsules, detached helpers and filtered pane views
  consumes: bridge dispatch, shared Pi runtime, legacy provider adapter, tool broker

[Shared Pi runtime]
  owns: pi-runtime.ts
  exposes: in-memory provider credentials, no-tools text completion, ephemeral tool-agent session
  consumes: pinned Pi SDK, OpenRouter or localhost OpenAI-compatible endpoint

[Legacy provider adapter]
  owns: openai-compatible.ts
  exposes: explicit rollback chat/tool transport with redacted trace and usage
  consumes: configured HTTPS or localhost OpenAI-compatible endpoint

[Utility tool broker]
  owns: utility-tools.ts
  exposes: search/read/status/diff/check/patch-proposal tools
  consumes: declared repository scopes and literal allowlists

[Native fallback control]
  owns: native-subagent.ts, loop-scoped provider profiles, provider hooks
  exposes: one short-lived Claude read-only lease, Codex fail-closed disablement, or strict zero-native mode
  consumes: settled utility evidence, current Governess epoch, provider lifecycle events
```

## Dependency graph

```text
main agents ──MCP──► bridge ──append──► utility store
    │                                  ▲
    ├─ Claude exact PreToolUse ────────┤
    └─ Codex exact PreToolUse/proxy ──► delegation telemetry
                                  ▲           │
                                  │           ▼
Governess ──route/epoch───────────┴────► task router + execution tier
    │                                         │ one owner
    ├──────────── spawn detached ─────────────▼
    │                                    bounded helper
    │                                    ├─► Direct ───────────────┐
    │                                    ├─► Nanny ──Pi──► Qwen   ├─► tool broker
    │                                    ├─► Au Pair ─Pi──► GLM   │
    │                                    ├─► context capsule ─────┘
    │                                    └─► bridge ──compact result──► requester
    │
    └─ current epoch + settled utility evidence ─► native fallback journal
                                                      │ one leased slot
Claude Agent ──PreToolUse/profile contract─────────────┘
                                                      ▼
                                              read-only native child
Codex spawn_agent ──config + PreToolUse──► denied (0.145 sandbox inheritance)

Nanny pane / Au Pair pane ──read only──► filtered utility store view
optional bridge supervisor ──messages/route request──► bridge
```

## Cross-cutting concerns

| Concern | Owner | Evidence |
|---|---|---|
| Route authority | Governess epoch + task router | `governess.jsonl`, utility `jobs.jsonl` |
| Helper context | Utility context loader/runtime | `utility/contexts/<job>.json`, capsule hash in result/usage |
| Secrets | Pi runtime, legacy adapter, and tool env scrubber | in-memory credentials; redacted `utility/llm-trace.jsonl` |
| Background jobs | Utility store/runtime | `utility/jobs.jsonl`, stale-claim fencing |
| Cost and tokens | Provider adapter/runtime | `utility/usage.jsonl` |
| Delegation adoption | Delegation policy, hook, and Codex proxy | `utility/delegation.jsonl` |
| Native fallback | Governess lease store and provider hooks | `native-subagents/events.jsonl`, hook journals, Governess board |
| Large outputs | Tool broker | patch/report artifacts referenced by result |
| Visibility | Governess and optional utility pane | pane output; never a control dependency |

## Blast-radius guide

| If you touch… | Also check… | Why |
|---|---|---|
| Bridge tool schema | Agent MCP config, bridge tests, prompt guidance | Both agents consume the public tool contract |
| Route/job types | Router, store replay, runtime and bridge utility adapter | Durable events must remain materializable |
| Context capsule | Path policy, runtime, provider prompt and observability | Repository text must stay bounded and non-authoritative |
| Governess epoch/loop | Utility claims, stale recovery, liveness tests | It is the single route authority |
| Tool broker | Worker prompt, scope tests, secret/command policy | This is the host security boundary |
| Pi runtime/provider adapter | No-builtins tests, retry/redaction/usage tests, fake and live canaries | External I/O must remain bounded and observable |
| Tmux layout | Pane identity, manifest assumptions, tmux tests | Existing code still has positional pane assumptions |
| Hook or Codex proxy | Delegation classifier, telemetry, bridge prompts, native lease/profile tests | Claude and Codex enforce utility adoption; Claude gates the read-only fallback while Codex native spawn fails closed |

## Harvto supervisor integration order

The reviewed supervisor changes form a linear dependency stack. Workspace
ownership and handover safety establish the state model used by peer delivery,
utility routing, lifecycle settlement, stale-write fencing, bridge deduplication,
and guarded patch application. Integrate the numbered branches in the order
defined in [Harvto Supervisor Defect Stack](harvto-supervisor-defect-stack.md).

D11 composer-safe recovery depends on the complete D10 tip. D12 manifest-backed
socket discovery remains parked until D11 is closed and independently reviewed.
