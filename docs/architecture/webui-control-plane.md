# Web UI Control Surface Architecture

## Status

Planned and uninstalled. The binding product and evaluator contracts are in
`specs/webui-control-plane/`.

This architecture adds a browser presentation and operator-interaction layer to
the current Loop runtime. It does not install the older portfolio-scale Agent
Operations Control Plane design, a workflow engine, a broker, or a database.

## Architectural outcome

The Web UI becomes the clean operator surface while durable files and
Governess remain authoritative:

```text
Browser
  ├─ snapshot + ordered SSE projection
  ├─ personal display preferences
  └─ later: typed command request and receipt
            │
            ▼
Loop local Web server (127.0.0.1)
  ├─ session/security boundary
  ├─ redacted public DTO boundary
  ├─ canonical fleet/run projector
  ├─ timeline/evidence projection
  └─ later: untrusted command inbox
            │
            ├─ authoritative reads
            │    ├─ run manifest and transcript
            │    ├─ normalized hooks
            │    ├─ Governess state/control journal
            │    ├─ bridge ledger
            │    ├─ utility job/usage/tool journals
            │    └─ native transcript usage projections
            │
            └─ diagnostic probes
                 ├─ tmux adapter identity and health
                 └─ process health

Later mutation path:

Web request -> untrusted inbox -> current Governess epoch
            -> identity/policy/fence/confirmation validation
            -> existing control journal and runtime adapters
            -> durable outcome receipt
```

## Ownership boundaries

| Component | Owns | Does not own |
|---|---|---|
| Browser client | Presentation, navigation, drafts, filters, personal layout | Lifecycle, authority, policy, delivery, worker tier, files, terminal input |
| Local Web server | Authentication, DTO allowlist/redaction, projections, SSE, bounded evidence lookup | Run truth, agent lifecycle, routing, command acceptance |
| Projection layer | Deterministic source materialization, freshness, quality, conflicts, cursors | Repair, expiry maintenance, acknowledgement, mutation |
| Governess | Epoch, driver lease, policy, control acceptance, dispatch | Browser rendering or personal preferences |
| Bridge | Durable participant messages and resolution | Browser navigation, workflow authority, model/tier choice |
| Utility control | Deterministic routing and one-owner bounded jobs | Peer-agent authority or browser-selected provider |
| Tmux/process adapters | Execution surface and corroborating liveness | Run identity, lifecycle, or control authority |

## Canonical run projection

A fleet entry is keyed by `{repoId, runId}` from a valid persisted manifest. It
is not keyed by tmux session, pane, PID, provider session, or process command.
The manifest's internal IDs must match the selected run-root location; a
mismatch is corrupt and does not create a canonical run.

The projector emits:

- run identity, workspace binding, lifecycle, created/updated time;
- current agent pair, roles, normalized liveness, usage, quota, and bridge
  summaries;
- Governess epoch, lease, health, pending controls, and advisory summaries;
- Direct/Nanny/Au Pair queue, ownership, activity, usage, result, and blockers;
- adapter identities and bounded positive health probes;
- a deterministic combined timeline;
- source revisions, freshness, data-quality state, and conflicts;
- opaque evidence IDs backed by containment-checked records.

### Data quality

Each source carries separate capability requirement (`required`, `optional`,
`disabled`, `not_applicable`) and observation (`current`, `stale`, `missing`,
`corrupt`, `conflict`, `unknown`) fields. The persisted resolved run
capabilities determine requirement. The normative cross-product and
source-specific freshness contracts live in `specs/webui-control-plane/spec.md`.
Notably, optional missing/unknown is healthy, optional stale/corrupt/conflict
contributes that state, and disabled/not-applicable is excluded. Each snapshot
is one of:

- `healthy`: required sources parsed and revisions remained stable;
- `stale`: required authority exists but exceeds its freshness contract;
- `partial`: a required source is missing/unknown or revisions changed twice
  during materialization;
- `corrupt`: a source failed schema/JSONL validation;
- `conflict`: sources assert incompatible run, epoch, lifecycle, or adapter
  identity.

When multiple conditions exist, aggregate severity is `conflict > corrupt >
partial > stale > healthy`. Each source returns its freshness contract ID,
effective threshold or null, semantic age basis, and provenance. Cross-file
reads are not transactional. The projector captures revisions, materializes,
rechecks, and retries once. A second change returns `partial`, not a mixed
snapshot labeled healthy.

## Source rules

### Run identity and lifecycle

The path-bound `RunManifest` owns run identity and current lifecycle. Terminal
run transcript events are non-atomic audit/corroboration because the manifest
is committed before its transcript append; lag or a malformed audit record is
partial/stale evidence, not automatically a lifecycle conflict. Process/tmux
scans can identify surviving or missing adapters but do not create, complete,
fail, or stop a run. `manifestRevision` is SHA-256 of the exact validated bytes
read after the atomic manifest rename; any byte change fences a future command.

### Governess

`governess-state.json` owns current epoch, lease, agent lifecycle, waiting, and
exit/handover state. `governess-control.jsonl` owns control phases and outcomes.
The ANSI board is a renderer, not an API. `governessDoctor` is not a Web reader
because it may migrate legacy state or rebuild/persist an index; the projection
requires a separate pure materializer.

### Bridge

`bridge.jsonl` owns messages and durable resolutions. The current
`readPendingBridgeMessages` performs expiry maintenance while reading, so the
Web work must first split a pure materializer from explicit maintenance. HTTP
GET imports may not append expiry, notification, acknowledgement, or delivery
records.

### Utility workers

`utility/jobs.jsonl` owns request, route, claim, and result state. The current
`readUtilityObservability` transitively reaches the mutating bridge reader, so
it cannot be imported by HTTP until a pure observability materializer is split
out. Direct, Nanny, and Au Pair remain tiers under one bounded-worker concept.

### Agent activity and usage

Normalized provider hooks own sequenced activity evidence. Pane text and pane
hashes are bounded diagnostics. Native transcript readers and Usage Tracker
snapshots own usage/quota projections with explicit confidence and provenance.

### Tmux adapter identity

The manifest currently records pane IDs and a session name but does not persist
the exact tmux socket/server identity. New runs store the canonical socket path,
tmux server PID, and positive OS process-birth identity. This distinguishes a
reincarnated server that reuses the same socket path/session name. Every
Web-facing diagnostic revalidates both socket and server-instance identity via
an explicit adapter context; it must never invoke the default tmux server.
Legacy manifests report adapter identity as unknown. Release 1 leaves existing
launch/resume/control admission unchanged. Before later Web commands, every Web
control consumer must use that same context and reject unknown identity.

## Browser structure

### Fleet

One compact row per run, grouped exclusively by precedence into Needs attention,
Cleanup debt, Active, or Finished with secondary reason badges. Search,
repo/state filters, and deterministic sorting support large fleets; quota,
cost, worker, bridge, and adapter details are disclosed on demand. Adapter
details are nested in the run, which eliminates competing top-level
tmux/process/run lists.

Attention details provide contextual read-only guidance and a fixed
`loop attach --run-id {validated-run-id}` fallback. The local CLI resolves the
adapter; no socket path or shell text derived from an agent label crosses the
Web boundary.

### Run workspace

The run page keeps identity, lifecycle, current driver/epoch, quality,
connection, and observation age in a persistent header. The desktop layout
keeps the existing mental model:

```text
frontier agent | frontier agent
Governess      | bounded worker
```

The regions are responsive components rather than fixed terminal cells. Each
agent has status, usage, event, bridge, and bounded-console sections. Governess
separates facts, interpretation, policy, and audit. The worker/timeline
replacement for the recon pane preserves route, tool, result, failure, usage,
and ownership evidence without promoting a tier to peer authority. Narrow
screens use Overview, Agents, Activity, and Timeline page sections rather than
nested tab sets.

### Timeline and evidence

The timeline normalizes lifecycle, hooks, bridge, Governess controls, driver
changes, worker jobs, review, proof, and terminal result events. History uses
opaque cursor pages: 100 rows by default, 200 maximum, deterministic filters,
and Older/Newer navigation bound to one projection revision. There is no
unbounded history response or offset pagination. Every entry shows source and
freshness and resolves through an opaque evidence ID. There is no arbitrary
path or raw-file endpoint.

### Configuration

- Browser-local in Release 1: theme, density, panel geometry, filters, time
  format, motion, update behavior, and non-safety notifications. These cannot
  suppress authority/data-integrity/security warnings.
- Read-only in Release 1: resolved run settings with value provenance.
- Later versioned run profile: next-run agent/model/effort/worktree/review/Governess/
  worker choices with value-source preview.
- Server-only: policy, capabilities, protected paths, credentials, provider
  endpoints, authentication, and forbidden actions.

The default origin is stable at `http://127.0.0.1:46327`; a conflict fails
clearly instead of auto-selecting another port. An explicit port override has
its own browser-storage namespace and preferences move only through
export/import.

## Transport and API

Release 1 uses:

- ordinary authenticated GET requests for initial/bounded data;
- Server-Sent Events for ordered one-way updates and reconnection;
- one non-safe session-bootstrap POST that cannot mutate a run;
- no run/runtime mutation routes; every other POST and all PUT/PATCH/DELETE
  return the typed read-only error.

SSE is a projection transport, not persistence. Each server start creates a UUID
stream epoch; a sequence begins at 1 and increments by one per event. The SSE
ID is `<epoch>:<sequence>`, separate from stable domain event identity. An old
epoch, cursor loss, gap, compaction, inode change, or queue overflow forces a
full snapshot. A slow client is disconnected rather than allowed unbounded
memory.

Future commands use ordinary JSON POSTs because request/receipt semantics are
clearer than a bidirectional socket. Commands carry stable identity,
idempotency, expected epoch/lifecycle/revision, and payload hash. The current
Governess epoch is the only component allowed to accept and translate them.

## Security boundary

The server:

- listens only on `127.0.0.1`;
- serves a non-secret bootstrap form, accepts a separately TTY-displayed
  >=128-bit code in an exact-Origin POST body within 60 seconds/five attempts,
  and exchanges it once for a separate >=256-bit HttpOnly, SameSite=Strict
  cookie;
- never places that code in a URL, argv, referrer, structured log, or browser
  storage; the initial top-level bootstrap GET returns no run data/session;
- validates exact Host always; safe GET/HEAD/SSE may omit Origin but reject a
  mismatch, while bootstrap/future non-safe requests require exact Origin; no
  wildcard CORS;
- uses no-store, strict CSP, frame denial, body/connection/rate bounds, and CSRF
  protection before mutations exist;
- exposes allowlisted DTOs only;
- escapes and redacts all agent/log text before serialization;
- resolves opaque evidence IDs with containment, symlink, size, and MIME rules;
- does not return environment, credentials, provider control URLs, raw provider
  messages, hidden reasoning, or arbitrary paths.

The Web server is operationally disposable. Killing it must not terminate or
alter agent, Governess, bridge, utility, manifest, or journal state.

GET handlers receive only capability-typed read dependencies. Acceptance
digests the complete fixture run tree before/after, asserts process/PID and tmux
state are unchanged, and spies on spawn, tmux, write, migration, rebuild, and
maintenance capabilities. Hashing a few journals is not sufficient proof.

## Client technology

The planned client uses React 19 with TypeScript and Vite. The UI has enough
independent, resizable, filterable, responsive regions to justify components.
Release 1 adds no UI kit, CSS framework, or state-management dependency. CSS
variables own theme and density. A small typed store owns snapshot and stream
state.

The Bun server and built assets are packaged with the existing compiled Loop
binary. `loop web` is additive; `loop dashboard` remains the terminal panel
until a later parity decision.

## Mutation safety for later releases

The browser never:

- writes a manifest or journal;
- runs a shell command or reads an arbitrary path;
- calls `tmux send-keys`;
- selects a utility provider/tier;
- passes `confirmed: true` as proof of confirmation;
- commits, pushes, merges, deploys, releases, discards work, or changes
  authority.

Lifecycle confirmation is a two-step Governess challenge bound to run, epoch,
action, payload hash, and current state. The challenge is short-lived and
single-use. An intervening state change invalidates it.

## Staged migration

1. Adapter identity/context, exact manifest revision, redacted resolved config,
   and capability-typed pure runtime reads.
2. Canonical read model and deterministic timeline.
3. Loopback server, authentication, and SSE.
4. Fleet and run workspace MVP.
5. Preferences, accessibility, performance, security, and parity
   certification.
6. Separately approved typed message/work-request commands.
7. Separately approved lifecycle controls and launch profiles.
8. Separately approved headless Governess and optional tmux adapter.

Each stage is a separate branch and eval so it can be applied or rolled back
without combining presentation, authority, and runtime topology changes.

## Failure invariants

- Silence is not death. A timeout is `unknown`.
- Missing/corrupt evidence is visible and fail closed.
- Duplicate commands return one existing receipt.
- Ambiguous dispatched commands remain pending and are not timeout-resubmitted.
- A non-empty terminal composer is preserved.
- A browser reconnect never reissues an action.
- The worker remains subordinate to Governess routing.
- The Web projection can always be rebuilt or discarded without changing run
  truth.

## Historical design relationship

The unmerged `codex/agent-operations-redesign` branch proposed a broader
portfolio/workflow/messaging architecture. This Web UI adopts its durable
projection lesson and deterministic-control boundary only. It does not depend
on Temporal, Restate, NATS, PostgreSQL, A2A, or a new memory/World Model service.
Those remain separate architectural decisions.
