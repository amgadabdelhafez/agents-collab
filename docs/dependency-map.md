# Dependency Map

Last updated: <!-- 2026-07-29 by refresh-dependency-map.sh -->

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

[Workflow orchestration]
  owns: workflow-port.ts, in-memory-workflow-port.ts, supervisor-message-workflow.ts, supervisor-message-coordinator.ts, supervisor-message-governance.ts, bridge-supervisor-message-delivery.ts, supervisor-message-read-model.ts, temporal-workflow.ts, temporal-workflow-port.ts, temporal-replay-runtime.ts, dbos-workflow.ts, dbos-workflow-port.ts, dbos-replay-runtime.ts
  exposes: engine-neutral start/signal/query/cancel/inspect, SupervisorMessage lifecycle, governed bridge delivery, and body-free board/Attention projections
  consumes: injected delivery activity, exact Temporal SDK 1.23.0, and exact DBOS SDK 4.27.6 for comparison evidence
  selected engine: Temporal for SupervisorMessage; DBOS comparison-only
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

supervisor intake ──► WorkflowPort ──► SupervisorMessage state machine
                                          │
                                          ├─► injected idempotent delivery activity
                                          └─► strict board read model
                                                   ├─► all message-board items
                                                   └─► action-required Attention items
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
| Workflow identity | WorkflowPort adapter | stable workflow ID, request IDs, immutable inspection history |
| Supervisor message policy | SupervisorMessage workflow | deterministic events, projection, and focused replay tests |
| Supervisor message visibility | Shared read model | strict board/Attention snapshots and cross-supervisor bridge proof |

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
| WorkflowPort contract | Reference adapter, SupervisorMessage workflow, Temporal adapter, DBOS comparison adapter, fixture corpus | All engines must preserve identity, idempotency, status, and history semantics; DBOS distinct-version recovery is a recorded incompatibility |
| SupervisorMessage state | Delivery activity, claim authority, Attention/message-board projection | Body and path redaction plus retry/escalation policy span every consumer |
| Replay fixture or digest | Reference, Temporal, and DBOS replay runtimes plus selection evidence | All engines execute identical inert steps and must match exact normalized observations |
| Engine selection | Temporal adapter and ORCH-SELECT-001 decision | Production topology, identity, credentials, recovery, observability, and deploy authority remain separate gates |
| Governed SupervisorMessage | Authority decision port, trusted supervisor route directory, existing bridge dispatcher, body-free receipt sink | No caller-supplied route paths; authorization must precede workflow or bridge mutation |
| SupervisorMessage read model | Canonical workflow projection and stable workflow ID | Reject extra fields and phase/action conflicts; never copy body, transcript, credential, or local path material |
