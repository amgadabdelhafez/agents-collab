# Spec: Loop Web Control Surface

## Status

This document defines the target product and the first releasable Web UI. It
does not claim that the Web UI is implemented or active.

## Problem

Loop's tmux workspace has the right operational concepts, but its presentation
is dense and fragmented:

- the two frontier agents, Governess, Nanny, Au Pair, Direct, and recon views
  compete for fixed terminal space;
- run identity, process discovery, tmux state, lifecycle, bridge delivery,
  usage, and worker evidence appear in different views and can disagree;
- facts, model interpretation, adapter diagnostics, and controls are visually
  mixed;
- history, evidence, filters, and configuration require reading
  terminal output or JSONL files manually;
- lifecycle controls are keyboard-only and their in-flight state is difficult
  to inspect;
- resizing, density, alerting, and per-user layout preferences are limited by
  tmux geometry.

The result is informative for an expert who already knows the internals, but it
is not a clean operator control surface.

## Goal

Provide a local-first browser UI that preserves Loop's paired-agent,
Governess, bridge, bounded-worker, lifecycle, usage, and evidence concepts while
making them clearer, live, configurable, replayable, and safe.

The browser is a projection and action client. Governess remains deterministic
control authority. Tmux remains an execution and compatibility adapter until
browser parity and fault testing prove it can become optional.

## Product principles

1. **Run-centric, not pane-centric.** One persisted run is the primary object.
   Pane IDs, PIDs, sockets, and sessions are expandable adapter diagnostics.
2. **Facts before interpretation.** Durable lifecycle, delivery, and control
   records are visually separated from model summaries and task labels.
3. **Every fact shows provenance.** A rendered status has a source, observed
   time, freshness, and data-quality state.
4. **No hidden terminal mutation.** Browser drafts do not touch an agent
   composer. A submitted action becomes a typed, idempotent command.
5. **Governess owns policy.** The browser cannot select worker tiers, weaken
   scope, grant authority, or manufacture confirmation.
6. **The worker is not a peer.** Direct, Nanny, and Au Pair are bounded execution
   owners, never drivers, reviewers, or recovery targets.
7. **Local and private by default.** Release 1 listens only on loopback and
   exposes redacted, bounded DTOs.
8. **Failure degrades to visible uncertainty.** Missing, stale, corrupt, or
   conflicting evidence never becomes a confident green state.
9. **Tmux survives migration.** The terminal dashboard and attach flow remain
   available until explicit parity and rollback gates pass.

## Release strategy

### Release 1: read-only local control surface

Release 1 adds `loop web` and leaves `loop dashboard` unchanged. It provides:

- a fleet view of persisted runs;
- a run workspace preserving the familiar two-agent top row and Governess plus
  bounded-worker bottom row;
- live ordered updates;
- a combined timeline with evidence links;
- redacted adapter console tails;
- personal display preferences;
- explicit stale, partial, corrupt, and conflicting data states;
- no run/runtime mutation endpoint; the sole non-safe route is the local
  session bootstrap exchange.

`POST /api/v1/session/bootstrap` may create only the ephemeral Web session. All
other POST requests and every PUT, PATCH, and DELETE return a read-only error.

### Later releases

Later releases are separately admitted and verified:

1. typed message and work-request commands;
2. confirmed lifecycle controls;
3. browser-native run profiles and launch;
4. a headless Governess runtime and optional tmux adapter;
5. remote access only after a separate authentication and transport threat
   model.

## Information architecture

### Fleet

Each canonical run has exactly one primary group, selected in this precedence
order, plus any number of secondary reason badges:

1. **Needs attention**: input required, an unresolved failed control, stale
   current authority, corrupt required evidence, or identity conflict;
2. **Cleanup debt**: otherwise, an ended or superseded run has surviving
   adapters or an active-looking manifest that needs deliberate reconciliation;
3. **Active**: otherwise, lifecycle is submitted, working, or reviewing;
4. **Finished**: otherwise, lifecycle is completed, failed, or stopped.

A compact row shows repository/worktree, run ID, lifecycle, driver, primary
attention reason, and age. Context, quota, cost, bridge, worker, and adapter
details are behind disclosure. The fleet supports search, repository and state
filters, and deterministic sorting by attention severity, most-recent durable
event, repository, and run ID. Tmux sessions and process rows never appear as
parallel fleet objects.

Attention details include a read-only next-step card. It explains input-required,
failed-control, and cleanup-debt conditions and can copy only the fixed,
run-keyed `loop attach --run-id {validated-run-id}` fallback command. The CLI
resolves and validates the adapter locally; the browser never receives a socket
path or constructs shell text from untrusted labels.

### Run workspace

Every run page has a persistent identity/authority header containing
repository/worktree, run ID, lifecycle, current driver and Governess epoch,
aggregate data quality, connection state, and last observation time. Desktop
layout below it preserves the existing spatial memory:

```text
┌──────────────────────────────┬──────────────────────────────┐
│ Frontier agent seat         │ Frontier agent seat          │
│ status, task, usage         │ status, task, usage          │
│ console/events/bridge       │ console/events/bridge        │
├──────────────────────────────┼──────────────────────────────┤
│ Governess control center    │ Bounded worker activity      │
│ facts, interpretation       │ Direct / Nanny / Au Pair     │
│ policy, alerts, audit       │ request -> tool -> result    │
└──────────────────────────────┴──────────────────────────────┘
```

Regions are resizable, collapsible, and pinnable. Resizing has keyboard presets,
minimum sizes, and a Reset layout action in addition to pointer dragging. On
narrow screens the page-level sections are Overview, Agents, Activity, and
Timeline; agent seats are accordions/segmented sections rather than a second
nested tab hierarchy. The persistent header remains visible. Layout changes are
personal preferences, not run mutations.

### Frontier agent seat

Each seat shows:

- provider agent identity and driver/reviewer role;
- deterministic lifecycle and last normalized hook event;
- advisory current task label with source and age;
- model, mode, reasoning effort, context use, and compactions;
- provider/window-aware account limits with provenance: session before weekly
  when both exist, unsupported windows omitted rather than invented, and
  unknown/stale reset data labeled explicitly;
- cumulative tokens, cost, burn rate, tool activity, and bridge counts;
- latest sent/received bridge message;
- desktop tabs for bounded console, events, usage, and bridge history.

Live lists auto-follow only while the operator is at the bottom. Reviewing
history preserves scroll position and shows an `N new` indicator plus a Resume
live action.

Provider payloads, hidden reasoning, secrets, and unrestricted tool output are
never exposed.

### Governess control center

The Governess region separates:

- **Facts:** current epoch, driver lease, lifecycle, adapter health, pending
  controls, bridge delivery, last durable event, and data quality.
- **Interpretation:** Progress, Next, waiting-for-human assessment, and local
  judge verdicts, each labeled with source, confidence, and generation time.
- **Policy:** action classes and the reason an action is allowed, blocked, or
  confirmation-bound.
- **Audit:** control ID, idempotency key, phase, transport, acknowledgement, and
  replay/evidence link.

Release 1 renders non-interactive **Policy and planned actions** cards with a
clear Read-only release label. It does not render disabled buttons or another
false action affordance.

### Bounded worker activity

The worker region shows Direct, Nanny, and Au Pair as execution tiers under one
bounded-worker heading. It includes queue/active/completed/failed counts,
routing reason, request, bounded tool activity, result or blocker, model calls,
tokens, cost, context capsule, and artifact references.

It never presents a utility tier as a third autonomous agent. Together with
the combined timeline, this region replaces the current recon/activity pane
and must preserve route, tool, result, failure, usage, and ownership parity.

### Timeline and evidence

One filterable timeline combines:

- run lifecycle and review/result events;
- normalized agent hook events;
- bridge enqueue, notification, delivery, expiry, supersession, and dead-letter
  events;
- Governess decisions and control phases;
- driver leases, recovery, handover, and exit state;
- worker route, claim, tool, result, and failure events;
- proof gates and terminal outcomes.

Every entry contains a stable display ID, source kind, source cursor/sequence,
event time, observed time, summary, severity, and an opaque evidence reference.
The browser never receives arbitrary local file paths.

Timeline history is cursor-paged, never delivered as one unbounded payload.
Initial and filtered pages contain at most 100 rows; the API accepts a maximum
limit of 200 and returns opaque older/newer cursors plus the snapshot revision.
Older/Newer page controls preserve filters, focus, scroll position, and stable
evidence links. Live events append only on the newest page; a historical page
shows `N new` and Return to live.

### Configuration

Configuration is divided into three classes:

1. **Personal display preferences (Release 1):** theme, density, column
   visibility, panel sizes, sections, filters, time format, motion, update
   behavior, and cost/usage notification thresholds. Stored in the browser and
   exportable as non-sensitive JSON. They cannot suppress identity conflict,
   corrupt/stale authority, failed-control, or security warnings.
2. **Run profiles (later release):** typed, versioned launch settings for agent pair, models,
   efforts, worktree/tmux mode, review/proof options, Governess timing, judges,
   utility routing, and retention. These apply to new runs unless a setting is
   explicitly proven hot-reloadable.
3. **Server-owned policy and secrets:** route authority, protected paths,
   capability scopes, credentials, provider endpoints, tokens, and forbidden
   actions. These are never browser-configurable or returned in DTOs.

Release 1 exposes only a read-only Resolved Run Settings inspector. Values show
their source: default, profile, environment, CLI, or persisted run override.
`loop web` uses the stable default origin `http://127.0.0.1:46327` and fails
clearly rather than silently selecting another port. An explicit `--port`
override creates a distinct browser preference namespace; export/import is the
only supported migration between origins.

## State authority and conflict behavior

| Concern | Authority | Diagnostic or advisory sources |
|---|---|---|
| Run identity and current lifecycle | path-bound `manifest.json` | terminal transcript audit events, PIDs, process names, tmux session presence |
| Governess epoch and driver lease | `governess-state.json` | pane header, model summary |
| Controls and outcomes | `governess-control.jsonl` | toast, terminal banner |
| Bridge messages and resolution | `bridge.jsonl` | notifications and composer text |
| Agent activity | normalized hook events | bounded pane hash/text, transcript tail |
| Utility job ownership and result | `utility/jobs.jsonl` | worker pane text |
| Usage and cost | native transcript readers plus Usage Tracker provenance | terminal status line |
| Tmux/process availability | positive bounded probes | absence or silence |

Transcript events are non-atomic audit/corroboration: manifest write precedes
the transcript append. A missing or lagging transcript record is partial/stale
audit evidence, not a lifecycle conflict. A manifest whose internal repo/run
IDs do not match its selected storage location is corrupt and cannot create a
canonical run.

Source capability and observation are separate fields:

- `requirement`: `required`, `optional`, `disabled`, or `not_applicable`,
  derived from the persisted resolved run capabilities;
- `observation`: `current`, `stale`, `missing`, `corrupt`, `conflict`, or
  `unknown`, produced by the pure reader.

The aggregate contribution is deterministic:

| Requirement | Observation | Aggregate contribution |
|---|---|---|
| required | current | healthy |
| required | stale | stale |
| required | missing or unknown | partial |
| required | corrupt | corrupt |
| required | conflict | conflict |
| optional | current or missing or unknown | healthy |
| optional | stale | stale |
| optional | corrupt | corrupt |
| optional | conflict | conflict |
| disabled or not_applicable | any | excluded from aggregate; source remains visible |

Aggregate quality is the strict maximum `conflict > corrupt > partial > stale
> healthy`. A stable cross-source read that changes twice contributes partial.
The projector lists every affected source and disables future controls whenever
authority is not current.

Freshness uses a versioned contract and fake-clock boundary tests:

| Source | Stale threshold and provenance |
|---|---|
| Manifest | none; a quiet valid manifest is current and lifecycle age is shown separately |
| Transcript, bridge, utility journal | none at file level; record deadlines/TTLs come from the durable record/policy |
| Governess state for active run | `max(30s, 3 * persisted governessTickMs)`; ended runs have no heartbeat threshold |
| Normalized agent hooks | no authority threshold; show last-activity age without declaring provider idle stale |
| Usage/quota snapshot | `max(30s, 2 * recorded pollIntervalMs)` from snapshot provenance |
| Tmux/process probe result | 10s from `loop.control/freshness-v1` |
| In-flight control | its persisted policy deadline |

Every `SourceRevision` exposes `freshnessContractId`, effective threshold or
`null`, observed time, semantic age basis, and provenance. Boundary tests cover
one millisecond below, exactly at, and one millisecond above each threshold.
For every non-null threshold, a source is stale only when `ageMs > thresholdMs`;
equality remains current. A persisted deadline is overdue only when the
observation time is strictly later than the deadline.

Cross-file reads are not atomic. The projector records source revisions before
and after materialization, retries once on change, and otherwise returns a
visibly partial snapshot.

## Interaction contract for later mutations

Each future action includes:

- schema version and command ID;
- idempotency key;
- repo ID and run ID;
- expected Governess epoch and run revision;
- an action-specific typed intent;
- payload hash and requested time;

The browser never supplies its actor identity. After authentication the server
stamps a non-forgeable local session identity onto the untrusted command before
it reaches the Governess inbox. `send-message` names an agent recipient.
`route-task` names a requester and result recipient but never a worker tier or
model; deterministic routing chooses execution ownership.

The Web server accepts an untrusted request only. The current Governess epoch
revalidates identity, lifecycle, policy, target readiness, confirmation, and
payload hash before journaling or dispatch. Duplicate requests return the
existing receipt. Ambiguous post-dispatch state remains pending and is never
blindly resent.

There is no generic shell, file, tmux-key, or generic Governess-action endpoint.
Commit, push, merge, deploy, discard-work, and authority changes remain
forbidden.

## Security and privacy

- Bind to `127.0.0.1` only. Do not bind to `0.0.0.0`.
- Generate at least 128 bits of randomness for a per-start, single-use bootstrap
  code with a 60-second TTL and at most five attempts. `loop web` opens/prints a
  non-secret `/bootstrap` URL and emits the code once to the controlling TTY;
  the operator submits it in an exact-Origin POST body. The code never appears
  in a URL/query/fragment, process argv, referrer, structured log, or browser
  storage. Success invalidates it and returns a separately generated 256-bit
  HttpOnly, SameSite=Strict session cookie.
- Require exact Host always. Permit missing Origin on safe GET/HEAD/SSE requests
  (including the initial bootstrap page), but reject a present mismatching
  Origin. The bootstrap POST and every future non-safe request require exact
  Origin. The initial form returns no run data and creates no authenticated
  session.
- Provide no wildcard CORS; use no-store caching, strict CSP, frame denial,
  JSON body limits, rate limits, and CSRF protection before any runtime-mutation
  release.
- Escape all agent/log text. Strip control sequences and apply credential and
  path redaction before creating public DTOs.
- Serve artifacts through opaque IDs after containment and symlink checks.
- Never return provider credentials, environment variables, remote control
  URLs, raw provider messages, hidden reasoning, or unrestricted transcripts.
- A Web server or browser crash must not affect agents, Governess, bridge, or
  utility execution.

## User journeys

1. **Fleet triage:** The operator runs `loop web`, opens the local bootstrap
   page, enters the separately displayed one-time code, and immediately sees
   which runs need attention and why.
2. **Run understanding:** The operator opens a run, sees both frontier seats,
   Governess, worker activity, and a source-linked timeline without attaching
   tmux or opening JSONL files.
3. **Stale evidence:** A tmux server stops answering. The run remains visible,
   tmux is marked unknown, lifecycle is preserved, and no false failure or
   cleanup action is inferred.
4. **Reconnect:** The browser sleeps or loses the event stream. It reconnects
   with the last event ID or requests a full snapshot if the cursor is gone.
5. **Personalization:** The operator resizes panels, chooses dense mode, pauses
   visual updates, and saves filters without changing run state.
6. **Future command:** The operator drafts a message in a browser-owned editor,
   reviews exact target and policy, submits once, and watches a durable receipt
   progress without terminal keystroke mirroring.

## Release 1 acceptance criteria

- [ ] **AC-01** `loop web` starts at the stable default loopback origin, fails
      clearly on a port conflict, opens or prints a non-secret bootstrap URL,
      and separately displays a one-time code; `loop dashboard` keeps its
      existing behavior.
- [ ] **AC-02** The fleet contains one canonical object per valid persisted run
      and nests tmux/process/session facts as adapters.
- [ ] **AC-03** Each run has exactly one primary group using the tested
      Needs-attention, Cleanup-debt, Active, Finished precedence and preserves
      every additional condition as a reason badge; attention details provide
      contextual terminal fallback guidance without exposing paths.
- [ ] **AC-04** A run workspace keeps a persistent identity/authority header and
      renders two frontier seats, Governess, and one subordinate bounded-worker
      region at desktop width, with Overview/Agents/Activity/Timeline narrow
      navigation.
- [ ] **AC-05** Agent seats show the required identity, lifecycle, model, effort,
      context, quota, cost, tokens, activity, and bridge fields when available.
- [ ] **AC-06** Facts and advisory interpretation show source, observed time,
      freshness, and confidence/data quality.
- [ ] **AC-07** The worker/timeline replacement for recon preserves one-owner
      Direct/Nanny/Au Pair semantics and route/request/tool/result/failure/usage
      evidence without raw provider content.
- [ ] **AC-08** The combined timeline is deterministically cursor-paged with
      bounded server-side filters, stable Older/Newer navigation, and an opaque
      evidence reference on every row.
- [ ] **AC-09** Initial state comes from a versioned snapshot; ordered SSE
      updates support event IDs, reconnection, gap detection, and full resync.
- [ ] **AC-10** Malformed or changing journals produce partial/corrupt state
      without crashing the fleet or returning confident success.
- [ ] **AC-11** HTTP projections use capability-typed pure manifest,
      Governess, bridge, utility, usage, and adapter readers; GET requests
      mutate no file, tmux state, process, index, cache, acknowledgement, or
      maintenance record.
- [ ] **AC-12** Bounded tmux/process probes are diagnostics. Timeout is unknown,
      not dead, and never changes lifecycle.
- [ ] **AC-13** The API returns only redacted DTOs and opaque evidence IDs. It
      exposes no credential, environment, provider-control URL, hidden
      reasoning, arbitrary path, or raw ANSI/control sequence.
- [ ] **AC-14** The server rejects non-loopback exposure, invalid Host/Origin,
      missing/expired session, path traversal, and unsafe artifact references.
- [ ] **AC-15** The session-bootstrap POST can create only ephemeral Web auth;
      every other non-safe route fails closed in Release 1 and no Web projection
      code imports a journal writer, tmux key sender, or lifecycle mutator.
- [ ] **AC-16** Personal preferences cover theme, density, layout, filters,
      time format, motion, update pause, and non-safety notifications; they
      persist across stable-origin restarts and cannot alter server policy or
      hide authority/data-integrity warnings.
- [ ] **AC-17** Live updates and panel sizing are keyboard accessible, do not
      steal focus or scroll position, expose `N new`/Resume live behavior, and
      do not announce high-frequency telemetry continuously to assistive
      technology.
- [ ] **AC-18** A Web server/browser crash leaves a fixture run and its Governess
      and agent processes untouched.
- [ ] **AC-19** Screenshot and DOM evidence covers fleet, run desktop, run
      narrow, stale/conflict, empty, error, and dense configurations.
- [ ] **AC-20** The performance, regression, security, and data-quality gates in
      `verify.md` pass with an independent evaluator and empty named-baseline
      failures.

## Non-goals

- Replacing Governess, the bridge, durable journals, provider-native channels,
  or tmux in Release 1.
- Remote or multi-user access.
- A hosted control-plane service, workflow engine, broker, or database.
- Raw terminal mirroring, hidden reasoning, or unrestricted log browsing.
- Direct browser edits to manifests, JSONL, environment, tmux, Git, or files.
- Automatic cleanup, commit, push, merge, deploy, release, or authority changes.
- A generic project-management system or resurrection of the entire historical
  Agent Operations Control Plane redesign.

## Superseded boundary

The original Governess pane spec correctly excluded a general Web dashboard
from that feature. This new spec deliberately adds a separate browser
projection. It does not expand the Governess pane's own responsibilities or
make its ANSI renderer an API.

## Open questions

No open question blocks Release 1. Later releases must resolve these through
their own specs:

- exact browser-native launch profile schema and secret injection flow;
- which safe message/work-request actions enter the first mutation release;
- the confirmation challenge lifetime and recovery UX;
- the parity observation window before `loop dashboard` changes default or tmux
  becomes optional;
- remote-access identity, TLS, and authorization if remote access is ever
  admitted.
