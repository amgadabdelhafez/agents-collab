# System Overview

## System map

```text
loop CLI / tmux launcher
  ├─ main agent pane ─┐
  ├─ peer agent pane ─┼─ loop bridge MCP + durable bridge JSONL
  ├─ delegation hook/observer ────┤
  ├─ governess pane ──┘           │
  └─ Nanny / Au Pair panes (read-only)
          │ route owner           │ route_task / compact result
          ▼                      │
  deterministic task router ◄────┘
          │
          ▼
  durable utility job journal ──► one selected execution owner
                                      ├─ Direct ──► bounded local tool broker
                                      ├─ Nanny ──Pi──► local Qwen + broker
                                      └─ Au Pair ─Pi──► OpenRouter GLM + broker

Claude Agent ──PreToolUse──► Governess native lease
Codex spawn_agent ──PreToolUse/config──► denied (sandbox inheritance)
                                                  ├─ strict: denied
                                                  └─ one read-only fallback

Separate read-only Nanny and Au Pair panes observe their filtered job streams.
An external bridge supervisor can submit/observe messages, but is not a route
or claim authority.
```

## Responsibilities

| Boundary | Owns | Does not own |
|---|---|---|
| Main agent pair | Product judgment, architecture, broad implementation, review | Utility scheduling or lower-tier host policy |
| Delegation policy | Exact mechanical intent classification, Claude pre-tool auto-submit, Codex miss telemetry | Route eligibility, arbitrary shell parsing, judgment classification |
| Bridge | Typed participant transport, delivery, acknowledgements | Task eligibility, model choice, host tool execution |
| Bridge wake/reconciliation | Filesystem doorbells, race-safe journal-version checks, persisted five-minute reconciliation evidence | Delivery acknowledgement, agent health, or lifecycle authority |
| Governess | Liveness, driver lease, current epoch, task routing and dispatch | Provider inference or unrestricted code changes |
| Task router | Pure capability/risk/scope/budget/tier decision | Provider calls, persistence, side effects |
| Utility job store | Idempotent append-only requests, decisions, claims, results | Routing policy or model inference |
| Direct | Exact structured broker calls with no model | Reasoning, scope inference, or permission changes |
| Nanny | Small read-only bounded reasoning on local Qwen through Pi | Edits, broad investigation, authority, or fallback to GLM |
| Au Pair | Larger bounded reasoning and patch proposals on GLM through Pi | Main-agent judgment, automatic patch application, or fallback to Nanny |
| Tool broker | Scope, path, command, environment, time/output policy | Choosing tasks or applying proposed patches |
| Pi runtime | Ephemeral provider/model sessions, tool lifecycle, usage/cost, redacted lifecycle trace | Routing, repository permission, persistent chat, or provider fallback |
| Memory checkpoint | Bounded pre-boundary continuity with exact run/session/source provenance | Raw transcripts, hidden reasoning, secrets, or operational authority |
| Curated memory | Explicit allowlisted Markdown promotion with a JSON provenance sidecar | Automatic learning, unresolved hypotheses, or release/route authority |
| Native fallback | One leased read-only provider child for bounded exploration or independent review after settled utility evidence | Worker pool, edits, shell mutation, MCP/web access, descendants, authority, or final review |

## Architecture invariants

- Paired tmux runs always have a governess; its epoch is required for a utility
  route and claim.
- `Agent` remains the full-agent lifecycle type. `utility` is only a bridge
  source and execution tier, never a driver, reviewer, or recovery target.
- Provider latency cannot block Governess ticks; Nanny and Au Pair inference
  runs in detached processes. Nanny defaults to one slot; Au Pair defaults to
  four independently accounted slots.
- Every accepted job has one durable owner (`utility-direct`,
  `utility-nanny`, or `utility-au-pair`). A full or failed tier does not cause
  implicit execution on another model.
- Governess is deterministic authority. Its local-Qwen classifications and
  summaries are advisory no-tools Pi completions.
- Agents or the narrow Claude pre-tool policy submit structured requests. They
  cannot select a model, weaken route policy, or grant new authority.
- A root `UTILITY.instructions.md` and explicitly selected bounded Markdown
  references supply provider-neutral project context. They never widen route or
  broker authority and their exact versioned capsule is persisted for replay.
- Missing evidence, stale epochs, malformed journals, protected paths, and
  unknown risk fail closed.
- Utility edits are patch proposals in P0. They are not applied automatically.
- Provider-native delegation is utility-first in governed tmux runs. The
  current Governess epoch may lease one run-wide read-only fallback for 120
  seconds after settled utility evidence; strict mode disables native agents.
  Hooks atomically consume the lease, bind the child lifecycle, scope reads,
  and deny mutation or descendants. The current fallback is Claude-only:
  Codex 0.145 reapplies the writable parent's sandbox to custom roles, so
  governed Codex configs disable agents and never advertise a false read-only
  boundary. Advancing the Governess epoch immediately fences the Claude child.
- Credentials stay in the provider process environment and are removed from
  tool child environments and traces.
- Pane and external-supervisor availability never determine job availability.
- Filesystem wake events are hints. The bridge journal remains authoritative,
  and the detached worker performs full reconciliation on startup and at least
  every five idle minutes. Notification and heartbeat state never count as
  message delivery.
- Claude checkpoints synchronously on `PreCompact`; Codex checkpoints before
  each user turn because its current hook surface has no stable pre-compaction
  event. Checkpoints contain metadata and bounded objectives, never bridge
  bodies, unrestricted transcripts, tool output, or credentials.
- Memory promotion is an explicit curated command. Pickbrain, Witchcraft, and
  any future local retrieval service consume its Markdown as a rebuildable
  projection and cannot mutate runtime truth.

## Key data flows

1. **Delegation:** a main agent calls `route_task`, or Claude's hook recognizes
   an exact low-risk mechanical intent and appends the same bounded request
   before denying the direct call. Current Codex and Claude per-tool hooks apply
   the same route adoption and native-fallback gate. Shell-tool classification
   uses the literal tool `workdir` as its effective cwd and resolves a leading
   literal `cd` from there; the selected root is accepted only after the shared
   Git-common-directory verifier proves it is the run root or a registered
   linked worktree. All adoption and native lease events are compactly
   journaled.
2. **Routing:** Governess reads pending requests, applies deterministic policy,
   records Direct, Nanny, or Au Pair as the one owner, and starts a detached
   process only for eligible work. Peer/driver/escalation routes return through
   the bridge.
3. **Execution:** the helper claims with the current epoch and persists one
   bounded context capsule for the verified worktree. Direct executes exact
   broker calls without inference; Nanny and Au Pair get ephemeral Pi sessions
   with only current broker tools active and every Pi built-in disabled.
4. **Completion:** the helper records tier, harness, Pi version, usage, trace,
   checks, artifact references,
   and a compact result, then sends that result to the requester through the
   bridge.
5. **Wake and reconciliation:** a durable bridge append wakes the detached
   worker through a filesystem event. A post-registration version check closes
   the inspect-to-watch race, while a metadata-only probe covers filesystems
   that coalesce events. The worker atomically records every full reconciliation
   and reruns it after at most five idle minutes. Only authoritative journal
   rows decide pending and delivered state.
6. **Continuity:** provider hooks atomically write an idempotent checkpoint to
   `<runDir>/memory/` before the relevant context boundary. A curator may later
   promote one verified stable fact with `loop __memory-promote`, producing
   readable Markdown plus a provenance sidecar.
7. **Recovery:** a new Governess epoch fences orphaned claims; time-limited jobs
   fail closed and return an escalation rather than being silently replayed.
8. **Native fallback:** after a settled helper result or route, **Claude** may
   request bounded read-only exploration/review. Codex may not: Codex 0.145
   reapplies the full-access parent sandbox after loading a custom role, so a
   role marked read-only is not a read-only child; Codex native agents are
   therefore disabled outright and its requests fail closed. Governess grants
   one current-epoch lease, holding a single run-wide **concurrency** slot — a
   completed or expired fallback frees it for a later request, but two never
   run at once. The next exact fallback-profile spawn consumes it, lifecycle
   hooks bind/close it, and every other fleet or child mutation attempt is
   denied, including `TeamCreate`.

See `specs/lower-agent-router/` and `specs/lower-agent-adoption/` for the feature
contracts and promotion gates.
