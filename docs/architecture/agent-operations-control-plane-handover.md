# Agent Operations Control Plane clean-session handover

Copy the prompt below into a new Codex task. It is intentionally
self-contained, but the living architecture document remains authoritative.

```text
Continue the Agent Operations Control Plane redesign for agents-collab as the
resident harness and control-plane architect. Work with me interactively to
finish the architecture decisions and admit the next bounded implementation
slice. Do not restart the discussion from generic first principles.

Repository and architecture truth

- Main repository: /Users/amgad/dev_projects/agents-collab
- Living architecture worktree:
  /private/tmp/agents-collab-agent-operations-redesign
- Architecture branch: codex/agent-operations-redesign
- Living document:
  /private/tmp/agents-collab-agent-operations-redesign/docs/architecture/agent-operations-control-plane-redesign.md
- Architecture document commit at handover: inspect the current branch HEAD;
  it includes Phase 0A completion and the decision sequence in section 17.
- Phase 0A implementation branch: codex/agent-operations-phase0-contracts
- Phase 0A implementation commit:
  3c504ee3a593aa91d8d5f5a6810617e8725a33ff
- Phase 0A passed native reviewer and independent root review. It is additive,
  unmerged, uninstalled, and not authoritative for any live lane.
- Installed live harness at handover: loop v1.0.38, local main commit
  bf2246f38658356bd62cd569e1abf48614cada63. Verify current live truth before
  relying on this possibly stale handover value.

Founder direction already established

1. Build a general Agent Operations Control Plane above individual loops and
   projects. It must support portfolios, projects, roadmaps, backlogs, work
   items, dependencies, incidents, releases, specialists, and three 8-hour
   shifts beginning at 00:00, 08:00, and 16:00.
2. Supervisors manage shift admission, unblocking, WIP, retrospectives, and
   acknowledged handoffs. Shift boundaries govern attention, not worker
   process lifetime.
3. Current loops, Governess, tmux, Codex, Claude, and utility runtimes remain
   execution adapters during migration. Product lanes stay authoritative and
   must not be interrupted.
4. Durable workflow direction: Temporal baseline with one frozen, bounded
   Restate challenger bakeoff. Airflow is not the control-plane workflow
   engine because this system needs interactive, long-lived, signal-driven
   durable state machines rather than batch DAG scheduling.
5. Messaging direction: NATS JetStream for durable commands, events, replay,
   acknowledgement, fan-out, and consumer recovery. CloudEvents-compatible
   envelopes carry lane, project, correlation, causation, idempotency,
   provenance, schema, and authority identity.
6. Management projection: PostgreSQL is the likely query/read-model store, but
   workflow history and durable events remain authoritative. Every projection
   must be rebuildable and freshness-visible.
7. Agent design: replace generic agents and scattered prompt charters with
   versioned AgentJobProfiles. Keep authority, capabilities/tools, data access,
   model policy, context recipe, memory policy, output contract, escalation
   policy, and persona as separate dimensions.
8. Context design: compile bounded, deterministic, provenance-bound context
   packages per job. Never accumulate an unlimited transcript. Packages expose
   omissions, hashes, policy, sensitivity, and incremental context requests.
9. Memory design: distinguish working, episodic, semantic, procedural,
   user-profile, and organizational memory. Use candidate, validation,
   curation, activation, dispute, supersession, retention, and retirement
   states. Git-backed curated knowledge remains durable project truth.
10. World Model design: it is a rebuildable temporal projection, never control
    authority. Separate deterministic ingestion from model-derived candidates;
    require provenance, bitemporal validity, contradiction handling, and
    bounded query contracts. Evaluate Graphiti only against a frozen corpus and
    competency questions.
11. Heartbeat design: separate event wakeups, durable workflow timers,
    reconciliation sweeps, and agent/process liveness. Events wake; timers
    schedule; reconciliation repairs; positive probes establish liveness.
    Silence and visible status counters are not state.
12. Observability: standardize on OpenTelemetry semantics across workflows,
    messaging, adapters, models, MCP tools, artifacts, and releases.
13. Reuse upstream infrastructure. Custom code should express our domain and
    adapter contracts, not reimplement workflow engines, brokers, tracing,
    schema standards, or agent/tool interoperability.
14. Shipping policy is UAT-led and low churn: smallest reversible slice, at
    most one direct regression for a confirmed defect, focused build/type
    smoke, one native zero-write review, concise independent review, and live
    observation. Avoid speculative test matrices and repeated planning loops.

Important research conclusions and upstream candidates

- Temporal: durable workflows, signals, updates, timers, child workflows,
  activity retries, human approval, and agent/MCP recipes.
- Restate: lightweight durable execution, TypeScript, workflows, timers, and
  keyed virtual objects; challenger, not an assumed winner.
- NATS JetStream: durable consumers, acknowledgement, replay, dedupe, KV
  watches, and object storage.
- CloudEvents: standard event envelope.
- MCP: agent-to-tool/resource/prompt capability boundary, not workflow truth.
- A2A 1.0: useful Agent Card, skill, task, message, streaming, and artifact
  compatibility model; internal compatible schemas first, network adapter
  later unless UAT proves the need.
- OpenAI Agents SDK and OpenClaw: useful composition, handoff, workspace,
  persona, skill, memory, active-hours, busy-deferral, and quiet-heartbeat
  patterns. Borrow the patterns; do not make either the control plane.
- LangGraph and Letta: useful distinctions between thread checkpoints,
  cross-thread memory, typed memory, and attachable memory blocks.
- Graphiti: candidate temporal context graph with episodes, provenance,
  validity windows, and hybrid retrieval; evaluate as a projection only.
- OpenTelemetry: common trace vocabulary for GenAI, MCP, messaging, and
  CloudEvents.

Incident lessons that constrain the design

- Shared tmux servers allowed one lane to kill another. Every lane must carry
  exact socket, session, process, port, workspace, run, and project identity.
- Broad process matching and kill-server operations are forbidden. Resolve a
  manifest and positively identify ownership first.
- Delivery ledgers, visible inbox nudges, and UI counters can drift from actual
  delivery or lifecycle truth. Reconciliation must consume terminal events and
  projections must be rebuildable.
- The Codex desktop Subagents panel showed 56 historical jobs as active even
  though the live collaboration tree had zero children and durable logs held
  terminal results. Never use a projection counter as authority.
- Turn-count-driven handoffs caused churn with ample context remaining. The
  shipped harness now uses context/compaction pressure rather than turn count.
- Live product UAT caught socket, delivery, handoff, and notification defects
  that broad green suites did not.

Parallel operating boundary

- Keep maintaining confirmed installed-harness defects in
  /Users/amgad/dev_projects/agents-collab/docs/quality/quality-scorecard.md.
- Each confirmed defect gets its own isolated repair worktree, socket, and run.
  Never implement an operational defect in a modernization worktree.
- Modernization proceeds additively, one explicitly approved bounded slice at
  a time. It cannot mutate or clean up AI-CUR, Harvto, or another product lane.
- AI-CUR identity: supervisor -> codex, subject prefix [AI-CUR], lane_id=ai-cur.
- Harvto identity: claude -> codex, subject prefix [HARVTO], lane_id=harvto.
- Informational status with requested_action=null needs no routine response.
- Do not push remote unless explicitly requested. Do not activate a new service
  or runtime authority without an approved cutover slice.

Current founder decisions to resolve

1. Confirm Temporal plus one Restate bakeoff, or select Temporal directly.
2. Confirm portfolio timezone, recommended America/Los_Angeles configurable per
   portfolio.
3. Confirm first pilot, recommended agents-collab plus one product project.
4. Confirm the initial role catalog.
5. Confirm local-only versus hosted non-authoritative memory inference.
6. Confirm SQLite baseline versus Postgres default for the World Model bakeoff.
7. Confirm internal A2A-compatible schema now and protocol adapter later.
8. Confirm CLI/Markdown management views first versus an early web dashboard.
9. Define founder notification severity and shift-handoff policy.
10. Define retention periods for workflow history, broker events, evidence,
    episodes, and curated memory.

How to continue

1. Read the living architecture document fully and inspect both branch heads
   and worktree status. Reconcile any drift before making recommendations.
2. Walk me through one material decision at a time. Lead with your recommended
   default, its tradeoff, and what concrete implementation slice it unlocks.
3. Record every founder decision immediately in the living architecture and
   update the backlog items it settles. Do not leave decisions only in chat.
4. Recommend one bounded Phase 0B slice after enough decisions are settled.
   The current recommendation is engine-neutral management state machines:
   legal transitions, dependencies, WIP, priority/severity, and exact shift
   boundary/handoff semantics. It must remain shadow-only and service-free.
5. Do not start a loop or implement Phase 0B until I explicitly approve that
   bounded slice. Once approved, use one isolated worktree/socket/run, one edit
   batch, one focused executable smoke, one zero-write review, eval.json, and a
   scoped commit, then stop for independent review.

First response in the new task

Give me a concise current-state recap, then ask for the first decision only:
whether to approve the recommended Phase 0B management-state slice and use
America/Los_Angeles as the configurable default portfolio timezone. Explain
what that slice will and will not change.
```

## Handover maintenance rule

When a founder decision changes, update the living architecture first, then
update this handover prompt in the same scoped documentation change. The
handover is a convenience snapshot, not a second authority.
