# System Overview

## System map

```text
loop CLI / tmux launcher
  ├─ main agent pane ─┐
  ├─ peer agent pane ─┼─ loop bridge MCP + durable bridge JSONL
  ├─ delegation hook/observer ────┤
  └─ governess pane ──┘           │
          │ route owner           │ route_task / compact result
          ▼                      │
  deterministic task router ◄────┘
          │
          ▼
  durable utility job journal ──► detached utility worker
                                      ├─ OpenAI-compatible inference
                                      └─ bounded local tool broker

Optional: a read-only utility pane observes the job journal. An external bridge
supervisor can submit/observe messages, but is not a route or claim authority.
```

## Responsibilities

| Boundary | Owns | Does not own |
|---|---|---|
| Main agent pair | Product judgment, architecture, broad implementation, review | Utility scheduling or lower-tier host policy |
| Delegation policy | Exact mechanical intent classification, Claude pre-tool auto-submit, Codex miss telemetry | Route eligibility, arbitrary shell parsing, judgment classification |
| Bridge | Typed participant transport, delivery, acknowledgements | Task eligibility, model choice, host tool execution |
| Governess | Liveness, driver lease, current epoch, task routing and dispatch | Provider inference or unrestricted code changes |
| Task router | Pure capability/risk/scope/budget/tier decision | Provider calls, persistence, side effects |
| Utility job store | Idempotent append-only requests, decisions, claims, results | Routing policy or model inference |
| Utility worker | One bounded job, compact prompt/tool loop, result/usage | Human communication, main-agent roles, commits or deployment |
| Tool broker | Scope, path, command, environment, time/output policy | Choosing tasks or applying proposed patches |
| Provider adapter | OpenAI-compatible HTTP, retries, usage/cost, redacted trace | Repository access or scheduling |

## Architecture invariants

- Paired tmux runs always have a governess; its epoch is required for a utility
  route and claim.
- `Agent` remains the full-agent lifecycle type. `utility` is only a bridge
  source and execution tier, never a driver, reviewer, or recovery target.
- Provider latency cannot block governess ticks; inference runs in a detached
  worker process.
- Agents or the narrow Claude pre-tool policy submit structured requests. They
  cannot select a model, weaken route policy, or grant new authority.
- Missing evidence, stale epochs, malformed journals, protected paths, and
  unknown risk fail closed.
- Utility edits are patch proposals in P0. They are not applied automatically.
- Credentials stay in the provider process environment and are removed from
  tool child environments and traces.
- Pane and external-supervisor availability never determine job availability.

## Key data flows

1. **Delegation:** a main agent calls `route_task`, or Claude's hook recognizes
   an exact low-risk mechanical intent and appends the same bounded request
   before denying the direct call. Codex's current per-turn-only hook surface is
   prompt-enforced and its app-server commands are measured for missed eligible
   calls. All adoption events are compactly journaled.
2. **Routing:** governess reads pending requests, applies deterministic policy,
   records the decision, and starts a detached worker only for eligible utility
   work. Peer/driver/escalation routes return through the bridge.
3. **Execution:** the worker claims with the current epoch, calls the configured
   OpenAI-compatible model, and executes only broker-approved tools.
4. **Completion:** the worker records usage, trace, checks, artifact references,
   and a compact result, then sends that result to the requester through the
   bridge.
5. **Recovery:** a new governess epoch fences orphaned claims; time-limited jobs
   fail closed and return an escalation rather than being silently replayed.

See `specs/lower-agent-router/` and `specs/lower-agent-adoption/` for the feature
contracts and promotion gates.
