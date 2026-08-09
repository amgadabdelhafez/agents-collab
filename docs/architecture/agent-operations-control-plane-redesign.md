# Agent Operations Control Plane Redesign

> Status: living architecture draft for founder review  
> Date: 2026-08-08  
> Scope: portfolio, project, shift, workflow, messaging, agent profiles, context,
> memory, World Model, observability, and execution adapters  
> Implementation status: no redesign implementation is authorized by this
> document

## 1. Executive decision

Evolve the current loop harness into an **Agent Operations Control Plane**.
Keep the overall system shape, but stop asking the loop process, Governess,
bridge JSONL, prompt charters, tmux panes, and periodic heartbeats to jointly
simulate a workflow engine, broker, project manager, identity system, memory
system, and observability stack.

The provisional target stack is:

| Concern | Provisional owner | Decision state |
|---|---|---|
| Durable business and operational workflows | Temporal | Accepted direction; run one lightweight Restate bakeoff before lock-in |
| Commands, events, fan-out, and replay | NATS JetStream | Accepted direction |
| Portfolio/project/shift management projection | PostgreSQL | Proposed |
| Agent-to-tool interface | MCP | Preserve and standardize |
| Agent discovery and task contract | A2A-inspired Agent Profiles | Proposed; internal first, protocol adapter later |
| Execution | Existing loop, Governess, tmux, Codex, Claude, and utility runtimes | Preserve as adapters, then simplify |
| Durable project knowledge | Git-backed Markdown and project knowledge bases | Preserve |
| Operational truth | Workflow history, signed commands, manifests, exact artifacts, and positive live checks | Preserve and consolidate |
| Working and curated memory | Provenance-backed memory service and project files | Redesign |
| World Model | Rebuildable temporal projection with explicit provenance | Preserve concept; redesign interfaces |
| Traces, metrics, and logs | OpenTelemetry conventions and collectors | Proposed |

The control plane is not another agent. It is deterministic infrastructure.
Models propose, interpret, summarize, implement, review, and escalate. Typed
workflows and policy code own deadlines, leases, retries, transitions,
idempotency, and authority.

## 2. Why a major redesign is justified

The current architecture has proved several important ideas in live work:

- durable append-only evidence is better than inferring state from a pane;
- explicit workspace, commit, socket, session, process, and port identity
  prevents cross-lane damage;
- coalesced doorbells and periodic reconciliation are safer than hot polling;
- context capsules should be bounded, immutable, and capability-aware;
- memory and World Model outputs must be derived projections, never control
  authority;
- role-specific workers outperform generic agents when their scope and tools
  are actually constrained;
- live UAT reveals orchestration failures that broad synthetic suites missed.

But the implementation accumulated these responsibilities inside one harness:

- project and backlog tracking;
- agent role prompts and scattered charters;
- routing and capability admission;
- message storage and notification;
- lifecycle, leases, retries, reconciliation, and handoff;
- tmux topology and process ownership;
- context selection and checkpointing;
- memory promotion and retrieval;
- World Model construction;
- status rendering and cross-project supervision.

That coupling explains the observed churn. A small correction to delivery,
handoff, socket identity, or context can affect launch, teardown, routing,
review, messaging, and supervision simultaneously. The redesign must reduce
the correction radius by making each of those contracts explicit.

## 3. Design principles

1. **Deterministic control, probabilistic work.** Models never own workflow
   state, authority, deadlines, delivery acknowledgement, or resource leases.
2. **One source of truth per concern.** Workflow history owns lifecycle;
   JetStream owns durable event delivery; Git owns versioned project artifacts;
   the management database owns query projections, not authoritative history.
3. **Commands are not events.** A command requests a state change and has one
   accountable owner. An event states what happened and may have many
   consumers.
4. **At-least-once plus idempotency.** Every side effect is safe to retry.
   Exactly-once marketing claims never replace receiver-side idempotency.
5. **Role is not persona.** Authority, tools, data access, output contract, and
   model policy are enforceable configuration. Tone and working style are a
   separate persona layer.
6. **Context is compiled, not accumulated.** Each job receives a bounded,
   provenance-bound context package derived for that job and role.
7. **Memory is not a transcript dump.** Working state, episodes, facts,
   preferences, procedures, and derived relationships have different lifetimes
   and promotion rules.
8. **The World Model is a projection.** Every statement traces to evidence and
   can be rebuilt, disputed, superseded, or omitted without blocking control.
9. **Heartbeats reconcile; events wake.** A timer can request inspection but
   cannot declare health or completion.
10. **Shifts govern attention, not process lifetime.** An eight-hour boundary
    produces a brief, retro, and ownership handoff. It does not restart healthy
    workers or throw away their execution context.
11. **UAT-led, minimally sufficient certification.** Reproduce the confirmed
    defect, make the smallest reversible change, run one direct regression when
    useful, build/smoke, release locally, and monitor live work.
12. **Adopt upstream infrastructure before extending custom machinery.** Keep
    custom code where it expresses our domain and replace custom code that
    reimplements workflow, messaging, tracing, or interoperability primitives.

## 4. Target system map

```text
Founder and portfolio policy
            |
            v
Portfolio / Project / Shift API and management projection
            |
            +------------------------+
            |                        |
            v                        v
Durable workflow engine         Query/read models
(Temporal provisional)          (PostgreSQL)
            |
            | commands, timers, signals, updates
            v
NATS JetStream event and command fabric
            |
       +----+-------------------+------------------+
       |                        |                  |
       v                        v                  v
Execution adapters        Context compiler   Projection workers
  - loop/tmux               - job profile      - management state
  - Codex                   - task package     - memory indexes
  - Claude                  - memory policy    - World Model
  - utility runtimes        - tool policy      - observability
       |                        |
       v                        v
MCP tools/resources       Git, project KB, memory store,
and A2A adapters          World Model, artifact store
```

Temporal or its selected challenger owns the durable state machines. NATS
connects independently deployable components and supports replay and fan-out.
The management database is rebuilt from workflow queries and events. The loop
does not become the database, broker, or project manager; it launches and
supervises concrete execution environments on request.

## 5. Portfolio, project, and shift model

### 5.1 Hierarchy

The control plane manages these stable entities:

```text
Portfolio
  Project
    Roadmap item
      Backlog item / work item
        Workflow execution
          Agent assignment
            Tool actions and artifacts
```

These are related but not collapsed. A project can have an independent
roadmap. A shared infrastructure task can block several projects. A resident
engineer can serve several projects without becoming their supervisor.

### 5.2 Work item contract

Every work item has:

- stable `work_item_id` and `project_id`;
- objective and acceptance outcome;
- type, priority, severity, and risk;
- dependency and blocking relationships;
- accountable owner role and optional assigned runtime instance;
- authority and approval requirements;
- required capabilities and context recipe;
- time box, deadline, and escalation policy;
- current workflow state and attempt lineage;
- expected artifacts and evidence;
- release or handoff destination;
- provenance for every material change.

The backlog is data with a schema, not a checklist embedded in prompts. Markdown
views remain useful for humans, but they are generated or synchronized from the
management model.

### 5.3 Three eight-hour shifts

There are three daily shifts beginning at `00:00`, `08:00`, and `16:00` in one
configured portfolio timezone. The timezone is an open founder decision.

Each `ShiftWorkflow`:

1. snapshots portfolio and project state;
2. admits a bounded set of work according to priority, dependencies, available
   roles, and work-in-progress limits;
3. assigns accountable supervisors and resident specialists;
4. monitors deadlines, blocked time, failed delivery, and unowned work;
5. requests intervention when deterministic recovery is exhausted;
6. produces an end-of-shift retro and next-shift brief;
7. transfers ownership through an explicit acknowledged handoff.

The shift boundary never kills a healthy workflow or agent session merely
because the clock changed. Long-running work remains in its durable workflow;
only management ownership and the shift brief advance.

### 5.4 Supervisor contract

A project supervisor is responsible for:

- maintaining the project roadmap and admitted shift backlog;
- keeping work assigned, bounded, and unblocked;
- monitoring product evidence and live UAT;
- escalating cross-project or infrastructure incidents using the structured
  envelope;
- ensuring completed work has the required artifact and release disposition;
- completing the shift retro and handoff.

A supervisor does not own harness implementation, global process cleanup, or
another project's resources. Resident harness, infra, DevOps, QA, security,
research, and product specialists expose capabilities to projects through the
same assignment contract.

## 6. Durable workflow layer

### 6.1 Workflow tree

The provisional Temporal hierarchy is:

```text
PortfolioWorkflow
  ProjectWorkflow(project_id)
    ShiftWorkflow(project_id, shift_id)
    WorkItemWorkflow(work_item_id)
      PlanOrTriageWorkflow
      ExecutionWorkflow(attempt_id)
      ReviewWorkflow(candidate_id)
      ReleaseWorkflow(candidate_id)
      IncidentWorkflow(incident_id)
```

Activities call external systems: Git, tmux, Codex, Claude, MCP tools, build
commands, notification services, and databases. Workflows contain deterministic
coordination only. Human or supervisor decisions arrive as typed workflow
updates or signals. Durable timers implement time boxes, retry delays, SLA
checks, shift boundaries, and reconciliation intervals.

### 6.2 Why Temporal is the baseline

[Temporal](https://docs.temporal.io/) guarantees workflow resumption after
process, network, or infrastructure failures and provides timers, schedules,
task queues, child workflows, message passing, and versioned workers. Its
[AI Cookbook](https://docs.temporal.io/ai-cookbook) now includes durable agent
loops, tool calling, MCP, human approval, and multi-agent examples. Those are
close to our failure modes, while keeping the workflow state outside the model
and tmux process.

### 6.3 Lightweight challenger: Restate

[Restate](https://docs.restate.dev/) is the only challenger worth a bounded
bakeoff before locking Temporal. It offers TypeScript SDKs, durable steps,
timers, external events, exactly-once-per-ID workflows, and keyed virtual
objects with single-writer state. Its smaller operational footprint and
stateful entity model could map cleanly to `Project`, `Shift`, `WorkItem`, or
`AgentRuntime` identities.

The bakeoff must implement the same small scenario in both engines:

- start a shift;
- admit one work item;
- assign one role;
- wait for an external agent result;
- survive engine and worker restarts;
- deduplicate a repeated result;
- time out and escalate a lost assignment;
- query current state and produce the shift handoff.

Select Temporal unless Restate achieves the same recovery, visibility,
versioning, and operator ergonomics with materially less complexity. This is a
technology gate, not an invitation to build both platforms.

### 6.4 Why not Airflow

[Airflow](https://airflow.apache.org/docs/apache-airflow/3.0.3/) remains
batch-oriented and says it is not intended for continuously running,
event-driven, or streaming workloads. Airflow 3.3 adds useful event-driven
scheduling and shared pollers, but the asset/DAG abstraction is a poor fit for
interactive, long-lived, human-in-the-loop project and agent lifecycles. It can
remain a data-pipeline adapter if a project later needs one; it should not own
the control plane.

### 6.5 Workflow invariants

- Workflow IDs are stable domain IDs, never PIDs, pane IDs, or mutable names.
- All external side effects use idempotency keys derived from workflow and
  operation identity.
- Retry policy is explicit per activity; permanent failure is distinct from
  retry exhaustion.
- Cancellation, pause, approval, rejection, and supersession are first-class
  states.
- Workflow code is versioned; old in-flight histories remain replayable.
- Large prompts, diffs, logs, and artifacts are stored by content hash and
  referenced from workflow history rather than embedded in it.
- A workflow can query live adapters, but silence never becomes evidence.

## 7. Messaging and streaming layer

### 7.1 NATS JetStream role

[NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) provides durable
streams, replay, retention, deduplication, work queues, key/value watches, and
object storage in the same lightweight server. Durable consumers track
delivery and acknowledgement, and pull consumers are recommended for scalable
processing and explicit flow control.

Use JetStream for:

- cross-project and cross-role commands;
- durable domain and operational events;
- supervisor incident intake;
- artifact-ready and result-ready notifications;
- projection updates;
- live status streams;
- dead-letter and operator-recovery streams.

Do not use Core NATS alone for work that must survive subscriber downtime.
JetStream's base contract is at-least-once, so receivers still require
idempotency and transactional side-effect handling.

### 7.2 Commands versus events

Suggested subjects:

```text
cmd.<portfolio>.<project>.<role>.<command>
evt.<portfolio>.<project>.<aggregate>.<event>
ops.<environment>.<service>.<event>
dlq.<portfolio>.<project>.<consumer>
```

Examples:

```text
cmd.main.ai-cur.supervisor.accept-work
cmd.main.shared.harness-engineer.investigate-incident
evt.main.ai-cur.work-item.completed
evt.main.ai-cur.shift.handoff-ready
ops.local.loop.execution-adapter.unavailable
```

Commands have one intended authority owner and a command outcome. Events are
immutable facts and can fan out to multiple consumers. A terminal doorbell is
only a presentation adapter for a durable command or event, never the message
itself.

### 7.3 Standard envelope

Use the [CloudEvents](https://cloudevents.io/) core envelope and extend it with
our domain identity:

```json
{
  "specversion": "1.0",
  "id": "01J...",
  "source": "agentops://portfolio/main/project/ai-cur/supervisor",
  "type": "com.agentscollab.work-item.blocked.v1",
  "subject": "work-item/WI-2026-0042",
  "time": "2026-08-08T20:15:00Z",
  "datacontenttype": "application/json",
  "project_id": "ai-cur",
  "lane_id": "product",
  "shift_id": "2026-08-08T16:00:00-07:00",
  "workflow_id": "work-item/WI-2026-0042",
  "actor_id": "supervisor/ai-cur",
  "role_id": "project-supervisor@1",
  "authority": "report-incident",
  "correlation_id": "...",
  "causation_id": "...",
  "idempotency_key": "...",
  "artifact_refs": [],
  "data": {}
}
```

Identity fields must agree with authenticated producer identity and workflow
state. Prose is never used to infer the lane.

### 7.4 Delivery states

Every command moves through explicit states:

```text
published -> broker-accepted -> consumer-delivered -> processing
          -> succeeded | rejected | failed-retryable | failed-terminal
          -> dead-lettered
```

Notification, terminal injection, and model receipt are observations. Only the
consumer's durable outcome and workflow transition discharge the command.

## 8. Agent profiles, personas, and role assembly

### 8.1 Replace generic agents and scattered charters

The current harness composes role guidance in source files, launch charters,
project instructions, bridge prompts, supervisor conventions, memory files,
and live handoff text. This makes it hard to answer what a specific agent was
allowed to do, which context it saw, and why it had a tool.

Replace that with a versioned `AgentJobProfile`:

```yaml
apiVersion: agentops/v1
kind: AgentJobProfile
metadata:
  id: harness-engineer
  version: 1.0.0
spec:
  mission: Diagnose and ship bounded harness fixes from confirmed incidents.
  responsibilities: []
  exclusions: []
  authorityPolicyRef: harness-engineer-local-release@2
  capabilityBundleRef: typescript-harness-maintainer@3
  contextRecipeRef: harness-defect-context@2
  memoryPolicyRef: engineering-resident-memory@1
  modelPolicyRef: high-reasoning-coding@1
  personaRef: concise-resident-engineer@1
  outputContractRef: reviewed-local-release@2
  escalationPolicyRef: harness-severity@1
```

The runtime resolves each reference, verifies versions and hashes, and emits an
immutable `AgentAssignment` snapshot. Changing a profile affects new
assignments; in-flight work keeps the profile version it started with unless a
workflow explicitly migrates it.

### 8.2 Separate the profile dimensions

| Dimension | Meaning | Enforced by |
|---|---|---|
| Mission and responsibilities | What job the agent is doing | Workflow and prompt |
| Authority | What decisions and mutations it may make | Policy engine and adapters |
| Capabilities | Which tools and operations are exposed | MCP/tool gateway and sandbox |
| Context recipe | Which evidence is assembled and at what budget | Context compiler |
| Memory policy | Which namespaces can be read or proposed for promotion | Memory service |
| Model policy | Provider/model/effort/fallback/cost constraints | Runtime adapter |
| Persona | Tone, interaction style, and collaboration habits | Prompt only |
| Output contract | Schema, artifacts, evidence, and completion requirements | Workflow and validator |
| Escalation policy | When and to whom the agent must yield | Workflow |

Persona cannot grant authority. A friendly “senior engineer” persona does not
gain shell, deployment, or cross-project access. Tool presence also does not
grant permission; the policy decision must authorize the invocation.

### 8.3 Initial role catalog

The first catalog should contain roles, not model vendors:

- portfolio operator;
- project supervisor;
- product manager;
- harness engineer;
- infrastructure engineer;
- DevOps/release engineer;
- QA/UAT engineer;
- security reviewer;
- researcher;
- implementation engineer;
- code reviewer;
- data/analytics engineer;
- documentation/knowledge curator;
- bounded utility worker.

Codex, Claude, local models, and future runtimes are eligible implementations
selected by model policy. They are not the role identity.

### 8.4 Upstream interoperability

The [A2A 1.0 specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
defines Agent Cards, skills, task lifecycles, messages, streaming status, and
artifacts for interoperating independent agents. We should adopt its useful
shape without making every local process a network service:

- generate an A2A-compatible or A2A-inspired card from each published role;
- expose skills and supported modalities from the capability bundle;
- map our `work_item_id` and attempt to A2A task/context IDs at boundaries;
- add a full A2A adapter only when an external agent system needs it.

Use [MCP](https://modelcontextprotocol.io/specification/2025-06-18/server/index)
for the agent-to-tool and agent-to-context edge. MCP already separates
application-controlled resources, user-controlled prompts, and model-controlled
tools. Experimental MCP Tasks can be adapted later, but they must not replace
the selected workflow engine's authoritative lifecycle.

## 9. Context compiler

### 9.1 Purpose

Every assignment gets the right context for its job rather than inheriting a
generic agent's whole history. The context compiler is deterministic software,
not an agent improvising a prompt.

Inputs may include:

- constitution and global safety rules;
- resolved job profile and authority decision;
- project identity, roadmap slice, and active shift brief;
- exact work item, acceptance outcome, dependencies, and current workflow
  state;
- current Git/worktree/commit identity;
- selected specs, architecture docs, and code neighborhoods;
- curated memories allowed by policy;
- World Model context with provenance and truncation markers;
- current capability names and schemas;
- relevant prior attempts, incidents, decisions, and reviewer findings;
- the founder's current explicit instructions;
- explicit exclusions and stale/superseded context.

### 9.2 Output contract

The output is an immutable `ContextPackage` containing:

- schema and compiler versions;
- assignment, role, workflow, project, and shift IDs;
- source references with content hashes and timestamps;
- ordered prompt sections and token budgets;
- tool/capability snapshot;
- memory and World Model query definitions;
- unknown, missing, stale, disputed, and truncated markers;
- complete package SHA-256;
- redaction and sensitivity labels.

Large content stays in content-addressed artifacts or MCP resources. The prompt
contains summaries and references. The agent can retrieve more only through
capabilities allowed by the assignment.

### 9.3 Assembly policy

Context is selected by recipe and evidence, then ranked inside explicit
budgets. It is never “the last N messages.” A recommended priority order is:

1. authority, safety, and user instructions;
2. work item and acceptance contract;
3. current workflow and live environment identity;
4. directly relevant project artifacts;
5. active decisions, constraints, and known defects;
6. curated role/project memory;
7. World Model neighborhood;
8. bounded prior-attempt episodes.

The compiler records what was omitted. An agent can return
`CONTEXT_INSUFFICIENT` with a bounded request instead of guessing.

### 9.4 Industry patterns to borrow

OpenAI's Agents SDK models an agent as instructions, tools, handoffs,
guardrails, structured output, and runtime context, and supports filtered
handoff input plus traces for model turns, tools, handoffs, and guardrails.
OpenClaw separates `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`,
`HEARTBEAT.md`, and `MEMORY.md`, and filters skills per agent. These validate
the separation we need, but our control plane must compile and enforce the
pieces per assignment rather than relying on workspace file convention alone.

## 10. Memory redesign

### 10.1 Memory taxonomy

Memory is divided by purpose and authority:

| Layer | Contents | Lifetime | Authority |
|---|---|---|---|
| Workflow history | State transitions, timers, commands, outcomes | Durable | Authoritative for workflow lifecycle |
| Operational event history | Delivery, adapter, process, and incident events | Retained by policy | Evidence, not sole live truth |
| Working memory | Current objective, scratch decisions, pending questions, checkpoints | Assignment or workflow | Non-authoritative working state |
| Episodic memory | Prior attempts, incidents, reviews, retros, outcomes | Project/role scoped | Evidence with provenance |
| Semantic memory | Stable facts, terminology, preferences, constraints | Curated and supersedable | Advisory unless source is authoritative |
| Procedural memory | Runbooks, proven repair sequences, checklists | Curated and versioned | Guidance; permissions still external |
| User and organization profile | Stable preferences and operating conventions | Curated and supersedable | Instruction input within policy |
| World Model | Relationships and temporal statements derived from sources | Rebuildable projection | Never control authority |

Short-term conversation state belongs to the agent runtime or workflow
checkpoint. Long-term memory is namespaced by portfolio, project, role, user,
and sensitivity. Cross-project recall is denied unless a policy explicitly
allows it.

### 10.2 Promotion lifecycle

```text
observed source
  -> memory candidate
  -> deterministic validation
  -> curator or workflow approval
  -> active curated memory
  -> superseded | disputed | retired
```

Every memory record includes source URI, source hash, observed time, validity
window, curator, confidence/status, applicable scope, sensitivity, and
supersession lineage. Raw transcripts, hidden reasoning, tool dumps, secrets,
unreviewed inference, and transient progress never promote automatically.

### 10.3 Retrieval

Retrieval combines:

- exact IDs and structured filters first;
- keyword/BM25 search;
- optional vector similarity;
- temporal and graph neighborhood constraints;
- role, project, sensitivity, and authority filters;
- diversity and recency only after relevance and provenance.

Returned memories include their provenance and why they matched. Retrieval
failure or an empty result is explicit, not silently treated as “nothing is
known.”

### 10.4 Storage recommendation

Start with PostgreSQL for records, namespaces, provenance, and full-text search,
plus pgvector only where semantic retrieval proves useful. Keep Git-backed
Markdown as the human-editable curated view for project decisions and
runbooks. Do not make a vector database the canonical memory store.

[LangGraph's memory model](https://docs.langchain.com/oss/python/concepts/memory)
usefully distinguishes thread-scoped checkpoints from cross-thread stores and
semantic, episodic, and procedural memory. [Letta memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/)
demonstrate dynamic attachment and revocation of persistent context. Borrow
those concepts, but keep our provenance, policy, and control boundaries.

## 11. World Model redesign

### 11.1 Preserve the good foundation

The current Phase 0 already has the correct core invariants:

- temporal statements with evidence hashes;
- observed/asserted/inferred/disputed/superseded status;
- explicit ontology and validation;
- bounded context queries;
- contradictions and supersession history;
- deterministic capsule hashes;
- no routing, release, lifecycle, or mutation authority.

The redesign should retain this data contract while separating ingestion,
storage, retrieval, and context compilation behind services.

### 11.2 Expanded model

The graph should cover:

- portfolio, project, roadmap, backlog, shifts, and dependencies;
- repositories, commits, components, specs, tests, and deployments;
- workflows, attempts, commands, events, artifacts, and evidence;
- people, supervisors, roles, profiles, capabilities, and assignments;
- decisions, constraints, incidents, findings, and supersession;
- memory records and the sources from which they were promoted.

Use bitemporal semantics where valuable:

- **valid time:** when the statement was true in the project world;
- **transaction time:** when the control plane learned or recorded it.

### 11.3 Deterministic and model-derived lanes

Keep two ingestion lanes:

1. deterministic producers create `observed` statements from Git, workflow
   history, broker events, manifests, and verified live probes;
2. models may create `candidate` or `inferred` statements with source evidence,
   never `observed` statements.

Promotion, contradiction resolution, and ontology changes are explicit
workflows. Model extraction can accelerate curation but never silently rewrite
the project state.

### 11.4 Graphiti evaluation, not default adoption

[Graphiti](https://github.com/getzep/graphiti) is a credible upstream temporal
context graph with episodes, provenance, validity windows, hybrid retrieval,
and incremental ingestion. It also brings a graph database, LLM-driven
extraction, embeddings, reranking, and optional telemetry. That is more
operational and probabilistic machinery than our deterministic Phase 0 needs.

Run a frozen-corpus bakeoff after the data contracts stabilize:

- current SQLite World Model;
- PostgreSQL relational/edge projection;
- self-hosted Graphiti with telemetry disabled.

Measure named competency questions, temporal correctness, contradiction and
supersession accuracy, provenance completeness, rebuild determinism, latency,
resource cost, and failure behavior. Adopt Graphiti only if it materially
improves retrieval without weakening deterministic observations or provenance.

## 12. Heartbeat redesign

### 12.1 Three different mechanisms

The current term “heartbeat” conflates three jobs. Split them:

1. **Events:** immediate durable notification that something changed.
2. **Timers/schedules:** deterministic wake-up at a deadline or shift boundary.
3. **Reconciliation sweeps:** periodic re-derivation from authoritative state
   to recover missed notifications and detect drift.

An agent heartbeat is only a low-cost decision turn over due tasks and queued
events. It is not the scheduler or source of liveness.

### 12.2 Recommended operation

- Temporal schedules start shifts and periodic reconciliation workflows.
- JetStream events wake projections and interested supervisors immediately.
- One coalesced notification represents a non-empty inbox until it is drained.
- Busy agents can defer non-urgent heartbeat turns.
- Heartbeats run in isolated, light-context sessions unless a task needs the
  main conversation.
- Active hours and shift ownership determine routine notification delivery.
- A heartbeat returns a structured decision: no action, notify, start workflow,
  escalate, or request human input.
- A quiet heartbeat generates no human-facing message.
- Reconciliation records what source ranges and versions it inspected.

OpenClaw's current heartbeat design provides useful mechanics to borrow:
`activeHours`, `skipWhenBusy`, `isolatedSession`, `lightContext`, a tiny
heartbeat checklist, and acknowledgement-only suppression. Its docs correctly
state that a heartbeat is a scheduled agent turn rather than a background task
record. We should keep that distinction and let the workflow engine own the
task records.

### 12.3 Liveness contract

- A process is alive only after a positive OS check against recorded identity.
- A session is alive only on the exact recorded socket and session name.
- An agent is ready only after its adapter publishes a current readiness event
  and a positive capability probe succeeds.
- A message is complete only after its consumer records a durable outcome.
- A workflow is healthy only according to workflow state and its explicit
  deadlines.
- A heartbeat timestamp proves only that reconciliation ran.

## 13. Observability and evaluation

Adopt OpenTelemetry traces, metrics, and logs across the control plane.
[OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
now include GenAI agents, model calls, MCP, messaging, CloudEvents, and CI/CD.

Required correlation fields:

- portfolio, project, shift, workflow, work item, attempt, assignment, and
  agent runtime IDs;
- trace, correlation, causation, command, and event IDs;
- role and profile version;
- repository, worktree, commit, candidate, and artifact hashes;
- model/provider and tool/capability identifiers;
- NATS stream, consumer, delivery attempt, and acknowledgement outcome;
- Temporal namespace, workflow/run ID, task queue, and activity attempt.

Do not capture secrets, hidden reasoning, or unbounded prompt/tool bodies in
traces. Store sensitive payloads as access-controlled artifacts and trace only
their hashes and classifications.

The primary quality loop is:

```text
confirmed live incident
  -> structured incident event
  -> bounded repair workflow
  -> minimal direct regression when useful
  -> build and focused smoke
  -> reviewed local release
  -> monitored live UAT
  -> incident closure or new evidence
```

Synthetic tests certify deterministic contracts. Live UAT certifies real
integration. Neither substitutes for the other.

## 14. What stays, what is wrapped, what is retired

### 14.1 Preserve

- exact workspace, commit, socket, session, PID, port, and artifact identity;
- content-hashed launch and context artifacts;
- positive live probes and owned teardown;
- bounded utility capabilities and protected-path rules;
- explicit review and release evidence;
- curated memory promotion constraints;
- Phase 0 World Model ontology, provenance, temporal status, and bounded
  contexts;
- Git-backed specs, architecture, decisions, runbooks, and project KBs.

### 14.2 Convert to adapters

- `loop` launcher and tmux management;
- Governess process supervision and UI;
- Codex, Claude, and utility runtimes;
- MCP bridge;
- Git worktree and release operations;
- local executable installation and rollback;
- project-specific supervisor channels.

Adapters consume typed commands, publish events, and report capability and
readiness. They do not decide the project workflow.

### 14.3 Replace or retire after cutover

- JSONL bridge as cross-project message broker;
- xchan identity conventions as the primary inter-supervisor protocol;
- prompt-driven lifecycle and handoff management;
- turn-count or generic heartbeat scheduling;
- scattered hard-coded role charters;
- custom retry, lease, succession, and reconciliation state machines already
  covered by the workflow engine;
- pane topology as identity;
- hand-maintained status projections that can be rebuilt from events;
- generic driver/reviewer pairs when a role-specific assignment is available.

### 14.4 Do not delete early

Run old and new paths in shadow mode. The existing journals and manifests remain
the operational authority until the new workflow and broker paths prove
recovery, replay, delivery, and cross-project isolation in live UAT. Retired
components remain available for rollback until the final cutover audit.

## 15. Migration strategy

### 15.0 Parallel operation and interruption safety

The redesign is delivered beside the current harness, never through a flag-day
replacement. Two independent work streams remain active throughout migration:

1. **Operations maintenance:** live UAT, incident intake, and the canonical
   defect register continue against the installed harness. Confirmed P0/P1
   regressions may preempt redesign work, but they receive their own worktree,
   socket, run, review, release, and rollback record.
2. **Control-plane modernization:** one bounded phase slice at a time builds
   additive contracts, shadow adapters, or projections. It cannot control,
   stop, restart, message, reserve, or mutate an existing product or harness
   loop until the later authority-cutover phase is explicitly approved.

Every modernization slice must use a distinct Git worktree, tmux socket,
session name, and dynamically allocated app-server/proxy ports. It must be safe
to stop without changing the installed executable or any live lane. Shadow
consumers are read-only with respect to current runtime state. A failure in the
new plane therefore degrades only its own view, never the underlying work.

The first build slice, **Phase 0A**, is intentionally engine-neutral. It adds
versioned domain contracts and deterministic validation for portfolio, project,
shift, work item, incident, assignment, artifact, command, and event records.
It does not install Temporal, Restate, NATS, Postgres, or Graphiti, and it does
not settle the remaining founder decisions. This creates executable boundaries
without prematurely choosing runtime authority.

### Phase 0: settle contracts

- finalize domain IDs and the command/event envelope;
- finalize portfolio/project/shift/work-item state machines;
- finalize job profile, assignment, context package, and memory schemas;
- decide workflow engine after Temporal/Restate bakeoff;
- decide portfolio timezone and initial role catalog.

### Phase 1: messaging shadow

- run local NATS JetStream;
- publish CloudEvents mirrors of existing bridge and supervisor events;
- build one idempotent projection consumer;
- prove replay, deduplication, dead-letter, and lane isolation;
- keep the existing bridge authoritative.

### Phase 2: workflow shadow

- implement one `WorkItemWorkflow` and one `ShiftWorkflow`;
- observe an existing live loop through an adapter without controlling it;
- replay a crash, repeated event, timeout, approval, and shift handoff;
- compare Temporal and Restate using the same scenario;
- select one engine.

### Phase 3: profile and context compiler

- create the profile registry and policy references;
- migrate harness engineer, project supervisor, implementer, and reviewer first;
- compile immutable assignment and context packages;
- expose tools through role-specific MCP capability bundles;
- stop generating generic charters for migrated roles.

### Phase 4: memory and World Model

- implement memory records, namespaces, promotion, supersession, and retrieval;
- ingest workflow, Git, and NATS evidence into the World Model projection;
- integrate context compiler queries;
- run the SQLite/Postgres/Graphiti bakeoff;
- retain Git-backed curated views.

### Phase 5: management projection and shift operations

- create portfolio, project, roadmap, backlog, WIP, shift, and incident views;
- generate shift briefs and retros from durable evidence;
- replace prose-only supervisor handoffs with acknowledged workflow updates;
- add resident specialist assignment across projects.

### Phase 6: authority cutover

- move one low-risk project to workflow and NATS authority;
- run fault injection and real UAT;
- migrate remaining projects by adapter capability;
- retire duplicate lifecycle and broker code;
- complete a same-binary, multi-project, isolated-socket audit;
- retain rollback snapshots until an agreed observation period passes.

## 16. Draft redesign backlog

This is the modernization backlog. Admission is phase-gated: only explicitly
approved bounded slices become implementation work. The legacy defect register
in `docs/quality/quality-scorecard.md` remains independently authoritative for
installed-harness incidents and is maintained throughout the redesign.

### Active slice: Phase 0A executable contracts

- [ ] P0A-01 Define stable IDs, schema versions, and runtime-validated records
      for the core management entities without selecting a workflow engine.
- [ ] P0A-02 Define a CloudEvents-compatible command/event envelope with lane,
      project, causation, correlation, idempotency, provenance, and authority
      fields.
- [ ] P0A-03 Reject missing, cross-lane, version-incompatible, and malformed
      records fail closed with machine-readable reasons.
- [ ] P0A-04 Add one focused executable smoke covering valid round-trip and the
      confirmed high-risk lane-mismatch rejection.
- [ ] P0A-05 Produce `eval.json`, a clean scoped commit, and stop for independent
      root review. Do not merge, install, or activate runtime authority.

### Standing operations-maintenance queue

- Maintain `docs/quality/quality-scorecard.md` and its defect records from live
  producer evidence while modernization runs.
- Give every confirmed defect its own isolated repair slice; never patch it in
  the control-plane worktree.
- Keep shipped defects closed unless new UAT evidence proves recurrence.
- Treat informational supervisor status as observation, not work admission.
- Preserve exact lane identity and socket ownership; one lane never cleans up
  or mutates another.

### Epic A: domain and management model

- [ ] A-01 Define portfolio, project, roadmap, backlog, shift, work item,
      attempt, assignment, incident, artifact, candidate, and release schemas.
- [ ] A-02 Define state machines and legal transitions for work items,
      incidents, assignments, reviews, and releases.
- [ ] A-03 Define dependency, WIP, priority, severity, deadline, and escalation
      semantics.
- [ ] A-04 Decide the portfolio timezone and exact `00/08/16` shift boundary
      behavior.
- [ ] A-05 Define end-of-shift retro and acknowledged handoff contracts.
- [ ] A-06 Define management projection consistency and rebuild rules.

### Epic B: workflow engine

- [ ] B-01 Freeze the workflow bakeoff scenario and acceptance measures.
- [ ] B-02 Implement the scenario in Temporal.
- [ ] B-03 Implement the same scenario in Restate.
- [ ] B-04 Select one engine and record the decision.
- [ ] B-05 Define workflow versioning, deployment, backup, and local recovery.
- [ ] B-06 Map portfolio, project, shift, work item, execution, review, release,
      and incident workflows.
- [ ] B-07 Define activity idempotency and external side-effect policy.

### Epic C: messaging

- [ ] C-01 Define CloudEvents extensions and schema-version policy.
- [ ] C-02 Define NATS subjects, streams, retention, consumers, and ACLs.
- [ ] C-03 Define command outcome, retry, dead-letter, and operator recovery.
- [ ] C-04 Define lane/project identity authentication and mismatch rejection.
- [ ] C-05 Define large-artifact claim-check storage.
- [ ] C-06 Build bridge/xchan-to-NATS shadow adapters.
- [ ] C-07 Prove replay, dedupe, coalescing, isolation, and consumer restart.

### Epic D: roles, personas, and capabilities

- [ ] D-01 Define `AgentJobProfile`, `AgentAssignment`, and registry schemas.
- [ ] D-02 Separate authority, capability, context, memory, model, persona,
      output, and escalation policies.
- [ ] D-03 Inventory and map every scattered current charter and role prompt.
- [ ] D-04 Define the initial role catalog with responsibility and exclusion
      boundaries.
- [ ] D-05 Define capability discovery using MCP and generated A2A-style cards.
- [ ] D-06 Define profile migration and in-flight assignment versioning.
- [ ] D-07 Define role suitability, cost, and fallback selection without binding
      roles to vendors.

### Epic E: context compiler

- [ ] E-01 Define `ContextRecipe` and `ContextPackage` schemas.
- [ ] E-02 Define source priority, token budgets, truncation, and omission
      reporting.
- [ ] E-03 Define policy-filtered retrieval from project files, memory, World
      Model, workflow history, and artifacts.
- [ ] E-04 Define sensitivity, redaction, and cross-project isolation.
- [ ] E-05 Define `CONTEXT_INSUFFICIENT` and incremental context requests.
- [ ] E-06 Define package hashing, caching, invalidation, and replay.
- [ ] E-07 Define runtime adapters for Codex, Claude, and utility agents.

### Epic F: memory

- [ ] F-01 Define working, episodic, semantic, procedural, user-profile, and
      organizational memory schemas.
- [ ] F-02 Define namespaces, retention, sensitivity, and access policy.
- [ ] F-03 Define candidate, validation, curation, activation, dispute,
      supersession, and retirement workflows.
- [ ] F-04 Define exact, full-text, vector, temporal, and graph retrieval order.
- [ ] F-05 Define memory evaluation using real work-item recall questions and
      provenance scoring.
- [ ] F-06 Decide PostgreSQL/pgvector boundaries and Git-backed curated views.
- [ ] F-07 Migrate current checkpoint and memory promotion records.

### Epic G: World Model

- [ ] G-01 Extend the ontology for portfolio, project, shift, workflow,
      assignment, role profile, memory, and incidents.
- [ ] G-02 Define deterministic event/Git/workflow ingestion.
- [ ] G-03 Define candidate/inferred model ingestion and curation.
- [ ] G-04 Define bitemporal and contradiction semantics.
- [ ] G-05 Define context compiler query contracts and bounds.
- [ ] G-06 Freeze the SQLite/Postgres/Graphiti bakeoff corpus and competency
      questions.
- [ ] G-07 Select storage/retrieval implementation and migration path.

### Epic H: heartbeat, shifts, and supervision

- [ ] H-01 Split events, timers, reconciliation, and agent heartbeat contracts.
- [ ] H-02 Define coalescing, busy deferral, active hours, light context, and
      quiet acknowledgement behavior.
- [ ] H-03 Define positive liveness and readiness probes per adapter.
- [ ] H-04 Define supervisor inbox, incident escalation, and response SLAs.
- [ ] H-05 Define shift admission, unblock, retro, and handoff workflows.
- [ ] H-06 Define resident specialist availability and cross-project assignment.
- [ ] H-07 Define founder notifications and material-change suppression.

### Epic I: observability, security, and operations

- [ ] I-01 Define OpenTelemetry resource, trace, span, log, and metric fields.
- [ ] I-02 Define sensitive-data and prompt/tool-body capture policy.
- [ ] I-03 Define identity, authentication, authorization, and audit records.
- [ ] I-04 Define local service topology, startup, backup, restore, and upgrades.
- [ ] I-05 Define SLOs for command delivery, workflow progress, shift handoff,
      context compile, memory retrieval, and projections.
- [ ] I-06 Define UAT-led release, rollback, and observation policy.
- [ ] I-07 Define disaster recovery and full rebuild from authoritative history.

### Epic J: adapter migration and deletion

- [ ] J-01 Specify the loop/tmux execution adapter contract.
- [ ] J-02 Specify Codex, Claude, utility, Git, release, and supervisor adapters.
- [ ] J-03 Shadow existing bridge and Governess events into the new control
      plane.
- [ ] J-04 Migrate one project and measure operational correction radius.
- [ ] J-05 Inventory duplicate custom lifecycle, broker, heartbeat, projection,
      and prompt-charter code.
- [ ] J-06 Retire replaced components only after live cutover and rollback proof.

## 17. Founder decisions still required

These decisions gate later phases but do not block the additive Phase 0A
contracts slice described above.

1. **Workflow lock-in:** keep Temporal as the baseline and approve the one-scenario
   Restate bakeoff, or choose Temporal without a bakeoff?
2. **Shift timezone:** are `00/08/16` boundaries in America/Los_Angeles, UTC,
   or a separately configured portfolio timezone?
3. **First management scope:** model all projects immediately, or pilot with
   agents-collab plus one product project?
4. **Initial role catalog:** which roles must exist in the first control-plane
   slice, and which can remain generic adapters?
5. **Memory locality:** must all memory and World Model inference remain local,
   or may an approved hosted model create non-authoritative candidates?
6. **World Model bakeoff:** preserve SQLite as the likely default, or make
   Postgres the default projection before evaluating Graphiti?
7. **A2A boundary:** generate compatible Agent Cards now, or adopt only the
   internal schema and defer protocol compatibility?
8. **Management UI:** start with CLI/Markdown views or build a web dashboard in
   the first pilot?
9. **Founder notification policy:** which severities and decisions should wake
   the founder immediately versus wait for shift handoff?
10. **Retention:** how long should workflow histories, broker events, raw
    operational evidence, agent episodes, and curated memories remain online?

## 18. Research conclusions as of August 2026

| Area | Current upstream direction | Design implication |
|---|---|---|
| Durable agent workflows | Temporal publishes agent-loop, MCP, tool-calling, human-approval, and deep-research recipes | Agent work can be an activity/child workflow without making the model the state machine |
| Lightweight durable execution | Restate combines durable steps, keyed virtual objects, workflows, timers, and TypeScript support | Run one constrained bakeoff before Temporal lock-in |
| Messaging | JetStream provides durable consumers, acknowledgements, replay, dedupe, KV watches, and object storage | Replace JSONL/xchan cross-lane transport, retain receiver idempotency |
| Event format | CloudEvents is a graduated CNCF event envelope | Standardize identity, correlation, causation, schema, and artifact references |
| Agent interoperability | A2A 1.0 standardizes Agent Cards, skills, task states, messages, streams, and artifacts | Model role capabilities compatibly; defer network adapter until needed |
| Tool/context interoperability | MCP separates prompts, resources, tools, lifecycle, and capability negotiation | Keep MCP at agent edge, not as workflow authority |
| Agent composition | OpenAI Agents SDK and OpenClaw separate instructions, tools, handoffs/skills, personas, workspaces, and memory | Replace generic charters with versioned job profiles and compiled context |
| Heartbeats | OpenClaw supports active hours, busy deferral, isolated/light sessions, and quiet acknowledgements | Borrow mechanics, while Temporal owns task records and timers |
| Memory | LangGraph separates thread checkpoints from cross-thread stores and semantic/episodic/procedural memory; Letta dynamically attaches memory blocks | Use typed namespaces and job-specific memory policy, not global transcript context |
| Temporal context graphs | Graphiti tracks episodes, provenance, validity windows, and hybrid retrieval | Evaluate as a projection only after deterministic contracts and frozen corpus exist |
| Observability | OpenTelemetry covers GenAI agents, MCP, messaging, CloudEvents, and CI/CD conventions | Use one trace vocabulary across workflows, broker, adapters, models, and tools |

## 19. Primary sources

- [Temporal documentation](https://docs.temporal.io/)
- [Temporal AI Cookbook](https://docs.temporal.io/ai-cookbook)
- [Restate documentation](https://docs.restate.dev/)
- [Restate services and workflows](https://docs.restate.dev/foundations/services)
- [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream)
- [JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)
- [CloudEvents](https://cloudevents.io/)
- [A2A Protocol 1.0 specification](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
- [Model Context Protocol server primitives](https://modelcontextprotocol.io/specification/2025-06-18/server/index)
- [MCP Tasks, experimental](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK agents](https://openai.github.io/openai-agents-python/agents/)
- [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- [OpenAI Agents SDK tracing](https://openai.github.io/openai-agents-python/tracing/)
- [OpenClaw agent workspace](https://docs.openclaw.ai/agent-workspace)
- [OpenClaw heartbeat](https://docs.openclaw.ai/heartbeat)
- [OpenClaw memory](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent)
- [LangGraph memory concepts](https://docs.langchain.com/oss/python/concepts/memory)
- [Letta attachable memory blocks](https://docs.letta.com/tutorials/attaching-detaching-blocks/)
- [Graphiti temporal context graph](https://github.com/getzep/graphiti)
- [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/)
- [Airflow event-driven scheduling](https://airflow.apache.org/docs/apache-airflow/stable/authoring-and-scheduling/event-scheduling.html)
- [Airflow positioning and limits](https://airflow.apache.org/docs/apache-airflow/3.0.3/)

## 20. Change log

- 2026-08-08: First living draft. Consolidated the proposed workflow and
  messaging layers with portfolio/project/shift management, role-specific
  profiles, context compilation, memory taxonomy, temporal World Model,
  heartbeat separation, observability, migration phases, and draft backlog.
