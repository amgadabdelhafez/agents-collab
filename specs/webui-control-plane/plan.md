# Plan: Loop Web Control Surface

## Approach

Build the Web UI as a local read-model consumer of the current Loop runtime.
First extract canonical, side-effect-free projections from existing readers.
Then add a loopback Bun server, ordered SSE stream, and a React/TypeScript client.
Only after the read-only surface passes parity and fault tests may separate
tasks add typed commands through Governess.

This avoids two high-risk shortcuts: parsing the ANSI Governess board as an API
and treating tmux/process discovery as lifecycle authority.

## Target architecture

```text
Browser client
  ├─ initial versioned snapshot
  ├─ ordered SSE projection updates
  └─ later: typed command request + durable receipt
          │
          ▼
Loop local Web server (127.0.0.1)
  ├─ session/security boundary
  ├─ public DTO/redaction boundary
  ├─ fleet + run read-model projector
  ├─ timeline/evidence resolver
  └─ later: untrusted command inbox
          │
          ├─ reads ─► manifest and run transcript
          ├─ reads ─► hooks and Governess state/control journal
          ├─ reads ─► bridge ledger and worker status
          ├─ reads ─► utility job/usage/tool journals
          ├─ reads ─► transcript usage and quota projections
          └─ probes ─► bounded tmux/process adapter health

Later command path:

untrusted Web command -> current Governess epoch -> policy + fence + journal
                      -> bridge/provider adapter -> durable outcome
```

## Source precedence

| Read model field | Primary source | Secondary source | Conflict behavior |
|---|---|---|---|
| Run key and current lifecycle | path-bound `RunManifest` | transcript audit plus process/tmux probe | mismatched path/IDs are corrupt; lagging audit is partial, not conflict |
| Governess epoch/driver | `governess-state.json` | board/pane label | primary wins; advisory labeled |
| Agent activity | normalized hooks | transcript/pane probe | report freshness per source |
| Bridge delivery | `bridge.jsonl` resolutions | notifications | pending until durable resolution |
| Control status | `governess-control.jsonl` | visual banner | journal phase only |
| Utility ownership/result | `utility/jobs.jsonl` | worker pane | ledger only |
| Usage/quota | transcript readers + Usage Tracker snapshot | pane text | expose confidence/provenance |
| Adapter health | bounded positive probe | none | timeout is unknown |

## Public contracts

### Snapshot envelope

```ts
interface ControlSurfaceSnapshot<T> {
  apiVersion: "loop.control/v1";
  generatedAt: string;
  projectionRevision: string;
  dataQuality: "healthy" | "stale" | "partial" | "corrupt" | "conflict";
  sources: SourceRevision[];
  conflicts: ProjectionConflict[];
  data: T;
}
```

Each `SourceRevision` identifies a source kind and opaque cursor, byte/sequence
revision, observed time, semantic age basis, separate requirement (`required`,
`optional`, `disabled`, `not_applicable`), separate observation (`current`,
`stale`, `missing`, `corrupt`, `conflict`, `unknown`), and the effective
freshness contract/threshold provenance. It never contains an arbitrary path.
Materialization uses the normative matrix and freshness table in `spec.md`;
aggregate precedence is `conflict > corrupt > partial > stale > healthy`.

`manifestRevision` is the lowercase SHA-256 of the exact validated manifest
bytes read after the existing atomic temp-file-plus-rename write completes. Any
byte change fences a future command. `projectionRevision` is a separate digest
of the ordered source kind/revision pairs and must not be used as a command
fence.

### Event envelope

```ts
interface ControlSurfaceEvent<T> {
  apiVersion: "loop.control/v1";
  eventId: string;
  streamEpoch: string;
  streamSequence: number;
  sourceEventId?: string;
  eventType: "snapshot" | "run.changed" | "timeline.appended" | "health";
  emittedAt: string;
  projectionRevision: string;
  runKey?: { repoId: string; runId: string };
  data: T;
}
```

On each Web-server start, `streamEpoch` is a new UUID and `streamSequence`
starts at 1 and increases by exactly one for every emitted event. `eventId` is
`<streamEpoch>:<streamSequence>` and is the SSE `id:` cursor; `sourceEventId` is
the stable domain/timeline identity when one exists. A cursor from another
epoch, a sequence gap, journal compaction, inode change, or bounded subscriber
overflow closes delta mode and forces a full snapshot. The new snapshot
continues the current epoch sequence.

### Release 1 endpoints

```text
GET  /api/v1/fleet
GET  /api/v1/runs/:repoId/:runId
GET  /api/v1/runs/:repoId/:runId/timeline?before&after&limit&filters
GET  /api/v1/evidence/:opaqueId
GET  /api/v1/events
GET  /api/v1/health
POST /api/v1/session/bootstrap
```

The fleet response can include summary objects; run and timeline detail remain
separate to bound payload size. The bootstrap POST can create only an ephemeral
Web session. Every other POST and all PUT/PATCH/DELETE return `405` with a typed
`read_only_release` error.

Timeline responses contain at most 100 rows by default and 200 by explicit
limit, ordered deterministically within one `projectionRevision`, plus opaque
`olderCursor`/`newerCursor` and `hasOlder`/`hasNewer`. Cursors bind the run,
filters, sort contract, and projection revision; a mismatched/stale cursor
returns a typed resnapshot response. There is no offset or unbounded history
response.

### Later command envelope

```ts
interface BrowserCommandBase {
  apiVersion: "loop.control/v1";
  commandId: string;
  idempotencyKey: string;
  requestedAt: string;
  run: { repoId: string; runId: string };
  expected: {
    governessEpoch: number;
    manifestRevision: string;
    lifecycle: string;
  };
  payloadHash: string;
}

type BrowserCommandRequest = BrowserCommandBase & (
  | {
      intent: "send-message";
      recipient: "claude" | "codex" | "supervisor";
      message: string;
    }
  | {
      intent: "route-task";
      requester: "claude" | "codex" | "supervisor";
      resultRecipient: "claude" | "codex" | "supervisor";
      task: string;
    }
);

interface WebControlCommand {
  request: BrowserCommandRequest;
  actor: {
    kind: "local-web-session";
    sessionIdHash: string;
  };
}
```

The browser request is untrusted and contains no actor field. The authenticated
server stamps the actor and rejects any client-supplied actor key. A Governess
consumer validates and translates the command into existing policy, journal,
bridge, and adapter contracts. `route-task` cannot name a worker tier or model.
Lifecycle actions use a Governess-issued, single-use, short-lived challenge. A
browser boolean is not confirmation.

## Module boundaries

Planned implementation seams under `loop-fork/`:

```text
src/loop/control-surface/
  types.ts             public and internal projection contracts
  sources.ts           side-effect-free source readers
  projection.ts        fleet/run materialization and conflict rules
  timeline.ts          deterministic event normalization and evidence IDs
  redaction.ts         public DTO and bounded console policy
  stream.ts            projection revisions, cursors, and subscribers
  security.ts          loopback session, origin, CSRF, headers, limits
  server.ts            Bun routes and lifecycle
  commands.ts          later, untrusted inbox only

src/webui/
  app/                 routing, snapshot store, SSE client
  components/          fleet, seat, Governess, worker, timeline, evidence
  styles/              design tokens, responsive layout, themes
  preferences/         versioned browser-local display settings
```

The existing terminal `panel.ts` will consume the shared read model after the
Web projection proves stable. It must not remain an independent parser forever.

## Technology decisions

| Decision | Choice | Rationale |
|---|---|---|
| Backend | Native `Bun.serve` | Already the runtime; routes, static assets, and SSE need no server framework |
| Live transport | SSE plus HTTP | One-way projection is simpler to reconnect, inspect, and bound than bidirectional sockets |
| Client | React 19 + TypeScript | Component-heavy, resizable, filterable operator UI benefits from explicit composition |
| Client build | Vite | Current official Bun-compatible React/TypeScript path with fast local iteration |
| Client state | Typed reducer/external store | Avoid a state dependency until measured complexity requires one |
| Styling | CSS variables and component CSS | Enables themes/density without a framework or generic visual identity |
| Persistence | Existing durable files | Release 1 adds no database or broker |
| Authentication | One-time bootstrap exchange + strict cookie | Protects even loopback data and prepares the later CSRF boundary |
| Remote access | Not supported | Requires a separate threat model, TLS, identity, and authorization |

## Sequence

### Phase A: prerequisites and contracts

1. Persist tmux socket/server identity for new runs, preserve atomic manifest
   writes, and expose the exact-byte manifest revision. Legacy manifests report
   unknown adapter identity.
2. Introduce an explicit socket-bound adapter context for Web-facing tmux
   diagnostics; never fall back to the default tmux server. This does not alter
   existing launch, resume, or control admission in Release 1.
3. Add a redacted resolved-config snapshot for new runs.
4. Split pure Governess, bridge, utility, usage, and adapter materializers from
   migration, index rebuild, expiry, acknowledgement, and other maintenance.
5. Define public snapshot/event/error DTOs and adversarial fixtures.

The adapter identity is structured as canonical socket path plus a positive
server-instance discriminator (tmux server PID and OS process-birth identity,
not session creation time). Both are captured at launch and revalidated before
every Web probe. A reincarnated server on the same socket path/session name is a
different adapter.

### Phase B: read model

1. Extract capability-typed, side-effect-free readers.
2. Define per-source states, required capabilities, aggregate quality severity,
   source revisions, and conflict rules.
3. Materialize one path-bound canonical run and mutually exclusive fleet
   summaries with reason badges.
4. Normalize the combined timeline and opaque evidence resolver.
5. Refactor the terminal panel to consume shared summaries after parity tests.

### Phase C: local server and streaming

1. Add the TTY-code bootstrap protocol on stable default origin
   `http://127.0.0.1:46327`, loopback-only session, and security headers. Port
   conflict fails clearly; only explicit `--port` changes the origin.
2. Add snapshot, timeline, evidence, health, and SSE routes.
3. Bound reads, payloads, event queues, clients, and refresh rate.
4. Add `loop web`; preserve `loop dashboard`.
5. Add the read-only, run-keyed `loop attach --run-id` fallback resolver without
   returning socket paths through Web DTOs.
6. Embed fixed-name built frontend assets in the compiled executable.

### Phase D: browser MVP

1. Build the design system, persistent run header, and responsive shell.
2. Build searchable/filterable fleet triage and run selection.
3. Build both agent seats, Governess, and route/tool/result-parity worker
   activity.
4. Build timeline, evidence drawer, connection/data-quality states, and update
   pause.
5. Add versioned personal preferences, keyboard layout presets/reset, and
   export/import.
6. Capture desktop, narrow, dense, empty, stale/conflict, activity, preferences,
   evidence, and failure evidence.

### Phase E: commands, separately admitted

1. Add a durable mode-0600 untrusted command inbox.
2. Add Governess consumption and typed receipts.
3. Start with `send-message` and `route-task`; the router selects tiers.
4. Add single-use confirmation challenges for lifecycle actions.
5. Prove duplicate, reconnect, stale epoch, ambiguous dispatch, non-empty
   composer, and Governess-down behavior.

### Phase F: tmux optionality, separately admitted

1. Extract Governess runtime from its renderer/pane process.
2. Keep Claude channel, Codex app-server, bridge, and tmux fallback as adapters.
3. Run a bounded parity observation window and rollback drill.
4. Only then consider making the Web UI the default dashboard and tmux optional.

## Failure behavior

- **Malformed journal:** mark the affected section corrupt; keep unaffected runs
  visible; all future controls disabled.
- **Source changes during read:** retry once; otherwise return partial with both
  observed revisions.
- **SSE cursor lost:** close delta mode and force a full snapshot.
- **Slow client:** bound the queue, disconnect, and require resnapshot.
- **Web server/browser crash:** runtime continues unchanged.
- **Governess absent or stale:** read-only remains; commands disable or stay in
  an untrusted pending inbox when that release exists.
- **Tmux timeout:** show unknown, preserve identity and lifecycle, never inject
  or clean up.
- **Duplicate command:** return the existing durable receipt.
- **Ambiguous dispatch:** remain pending; never resend by timeout.
- **Malicious log text:** escape and redact; never use `innerHTML` for untrusted
  content.
- **Preference corruption:** reset display preferences only; never affect run
  or server configuration.

## Migration and rollback

- Release 1 is additive and launched only by `loop web`.
- The existing terminal dashboard, tmux workspace, and Governess pane remain
  unchanged fallbacks.
- Each implementation task uses its own branch, run folder, eval, and scoped
  commit so projection, server, UI, commands, lifecycle, and tmux optionality
  can be applied or rolled back independently.
- No task changes runtime authority and presentation in the same release.
- A rollback removes the Web server entrypoint/client while leaving existing
  durable formats readable.

## Risks

- **Projection looks authoritative:** mitigate with source/freshness display,
  conflict states, rebuild tests, and no browser-owned lifecycle.
- **GET mutates state:** mitigate with import boundaries and pure reader tests,
  especially bridge expiry handling.
- **Sensitive terminal content leaks:** mitigate with public DTO allowlists,
  redaction fixtures, opaque evidence IDs, and no raw transcript route.
- **Framework expands the binary:** mitigate with fixed bundle budget and no UI
  kit/state framework in Release 1.
- **Live updates overwhelm users or assistive tech:** mitigate with coalescing,
  pause, focus preservation, and limited polite status messages.
- **Legacy runs lack socket/config identity:** display unknown and block later
  controls; do not infer across tmux servers.
- **Web UI becomes another custom monolith:** keep projection, transport,
  security, client, and command consumer in explicit modules.

## Not doing

- No implementation in the design slice.
- No direct Web-to-tmux key path.
- No remote mode, multi-user roles, hosted service, database, NATS, Temporal, or
  Restate dependency.
- No Web-accessible shell, arbitrary file reader, Git mutation, provider secret,
  or generic action endpoint.
