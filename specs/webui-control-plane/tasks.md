# Tasks: Loop Web Control Surface

Each task is an independently reviewable branch/worktree with its own
`runs/{task-id}/`, eval, exact diff scope, and rollback. A later task may branch
from the reviewed commit of its prerequisite; do not combine the stack into one
irreversible branch.

## Delivery graph

```text
T-00 adapter identity/config prerequisites
  └─► T-01 canonical read model
       └─► T-02 local server + SSE
            └─► T-03 fleet browser shell
                 └─► T-04 run workspace + timeline
                      └─► T-05 preferences, accessibility, MVP certification
                           ├─► T-06 typed messages/work requests
                           │    └─► T-07 lifecycle confirmation controls
                           └─► T-08 browser launch profiles
                                └─► T-09 headless Governess/tmux optionality
```

## Checklist

- [ ] **T-00** Durable adapter identity and resolved config
- [ ] **T-01** Canonical side-effect-free read model
- [ ] **T-02** Loopback server, authentication, and SSE
- [ ] **T-03** Fleet shell and design system
- [ ] **T-04** Run workspace, timeline, and evidence
- [ ] **T-05** Preferences, accessibility, and read-only MVP certification
- [ ] **T-06** Typed message and work-request commands
- [ ] **T-07** Lifecycle confirmation controls
- [ ] **T-08** Browser-native run profiles and launch
- [ ] **T-09** Headless Governess and optional tmux adapter

## T-00: Durable adapter identity and resolved config

**Goal:** New manifests contain enough verified adapter identity and redacted
effective configuration for a browser to report exact topology without
guessing.

**Files:** `loop-fork/src/loop/run-state.ts`, `tmux.ts`, `tmux-control.ts`,
Web-facing adapter probes, configuration types, and tests.

**Requirements:**

- persist structured tmux identity: canonical socket path plus server PID and
  positive OS process-birth identity, not session creation time;
- preserve backward-compatible reads of legacy manifests as `unknown`;
- preserve the existing atomic temp-file-plus-rename manifest write and define
  `manifestRevision` as SHA-256 of the exact validated persisted bytes;
- persist a redacted, immutable, versioned resolved-config snapshot;
- never store credentials, tokens, raw environment, or provider secrets;
- introduce an explicit socket/server-instance-bound adapter context for every
  Web-facing tmux diagnostic, revalidate both identity parts, and forbid
  default-server fallback;
- make no change to existing launch/resume/control admission in Release 1;
  future Web commands must reject unknown identity and use the explicit adapter
  context in every diagnostic/control consumer.

**Done when:** Manifest round-trip/atomicity/revision, legacy, redaction, two
sockets with identical session names, and same-socket server reincarnation all
pass; the Web diagnostic selects only the persisted server instance and eval
proves no live authority change.

## T-01: Canonical side-effect-free read model

**Goal:** One typed service materializes fleet/run/timeline projections from
durable sources with source revisions, quality, freshness, and conflicts.

**Files:** new `loop-fork/src/loop/control-surface/{types,sources,projection,timeline,redaction}.ts`, targeted existing readers, tests.

**Requirements:**

- define a capability-typed read-only dependency interface;
- split pure Governess, bridge, utility-observability, usage, and adapter
  materializers from migration, index rebuild, expiry, acknowledgement, send,
  process, tmux, and other maintenance;
- GET-facing imports contain no append/write/migrate/rebuild/send/spawn/kill/
  restart/default-tmux functions;
- materialize manifest, transcript, hooks, Governess state/control, bridge,
  utility, usage, and bounded adapter diagnostics;
- retry once when source revisions change during a read;
- derive a separate requirement/observation pair from persisted capabilities
  and pure reads, implement the normative aggregate matrix, and expose the
  versioned source-specific freshness contract/threshold provenance;
- fake-clock test every freshness threshold at below/equal/above boundaries;
- require manifest repo/run IDs to match the selected run-root path; mismatches
  are corrupt and never canonical;
- key one run by repo ID plus run ID and never turn tmux/process rows into runs;
- generate opaque evidence references with containment checks.

**Done when:** Golden, malformed, changing-source, stale, conflict, legacy, and
no-write tests pass on producer-derived fixtures.

## T-02: Loopback server, authentication, and SSE

**Goal:** `loop web` serves the versioned read-only API and live stream safely
from the compiled Loop executable.

**Files:** new `control-surface/{security,stream,server}.ts`, CLI dispatch,
build/package files, tests.

**Requirements:**

- bind only to stable default `127.0.0.1:46327`; fail clearly on conflict and
  change origin only through an explicit `--port` override;
- open/print only a non-secret bootstrap URL, accept a separately TTY-displayed
  >=128-bit, 60-second, five-attempt code in an exact-Origin POST body, and
  exchange it once for a separate >=256-bit strict session cookie;
- never place the bootstrap code in a URL, process argv, referrer, structured
  log, or browser storage;
- enforce exact Host always; allow absent Origin only on safe GET/HEAD/SSE while
  rejecting mismatches; require exact Origin on bootstrap/future non-safe
  requests; enforce no CORS, CSP, no-store, frame denial, request limits, and
  safe shutdown;
- implement fleet, run, timeline, evidence, health, and SSE endpoints;
- implement cursor-bound timeline filters/pages with default 100, maximum 200,
  opaque Older/Newer cursors, and stale-cursor resnapshot;
- emit `<streamEpoch>:<streamSequence>` event IDs with a UUID epoch and strictly
  increasing integer sequence; support `Last-Event-ID`, epoch/gap/full-resync,
  bounded subscriber queues, and slow-client disconnect;
- allow only `POST /api/v1/session/bootstrap` to create an ephemeral Web
  session; return `405 read_only_release` for every other POST and every
  PUT/PATCH/DELETE;
- embed fixed-name built assets in the compiled binary;
- add read-only `loop attach --run-id` resolution/validation for terminal
  fallback guidance without exposing socket paths in Web DTOs;
- leave `loop dashboard` unchanged.

**Done when:** API, security, reconnect, backpressure, crash-isolation, compiled
binary, and CLI compatibility tests pass.

## T-03: Fleet shell and design system

**Goal:** A clean responsive browser shell lets an operator triage all runs and
open one run without terminal knowledge.

**Files:** `loop-fork/src/webui/`, Vite configuration, `package.json`, lockfile,
component tests, and UI fixtures.

**Requirements:**

- React/TypeScript client with no UI kit or state framework;
- design tokens for semantic colors, typography, density, spacing, focus, and
  reduced motion;
- mutually exclusive Needs attention, Cleanup debt, Active, and Finished groups
  using the specified precedence plus secondary reason badges;
- compact canonical run rows with search, repo/state filters, deterministic
  sorting, and details/adapters nested in disclosure;
- contextual input-required, failed-control, and cleanup-debt guidance with
  only the fixed run-keyed terminal fallback command copyable;
- live/behind/reconnecting/stale state, manual resync, and update pause;
- keyboard navigation, visible focus, semantic landmarks, and no focus theft;
- empty/loading/error/offline states.

**Done when:** Desktop and narrow screenshot/DOM checks, keyboard tests, stream
reconnect tests, and bundle budget pass.

## T-04: Run workspace, timeline, and evidence

**Goal:** The browser preserves the familiar paired-agent workspace while
making facts, interpretation, worker evidence, and history inspectable.

**Files:** Web UI workspace, seat, Governess, worker, timeline, evidence, and
responsive layout components; projection DTO extensions if required.

**Requirements:**

- persistent run identity/authority header above all responsive regions;
- two frontier seats with identity, role, lifecycle, provider/window-aware
  usage/quota, context, cost, activity, and bridge sections;
- separate Governess facts, interpretation, policy, and audit groups;
- subordinate Direct/Nanny/Au Pair activity view with one-owner language and
  recon route/tool/result/failure/usage parity;
- resizable/collapsible/pinnable desktop regions with keyboard presets, minimum
  sizes, and Reset layout;
- Overview/Agents/Activity/Timeline narrow navigation without nested tab sets;
- deterministic filtered timeline and opaque evidence drawer;
- cursor-bounded Older/Newer history navigation with at most 200 rows per page,
  stable filter/cursor URLs, and no unbounded client render;
- history-safe live feed: auto-follow only at bottom, `N new`, Resume live, and
  scroll/focus preservation;
- bounded, escaped, redacted console view that is explicitly diagnostic;
- non-interactive Policy and planned actions cards, not disabled controls, and
  no POST path.

**Done when:** Required field, redaction, ordering, layout, empty/corrupt/stale,
dense, and responsive checks pass with screenshots and DOM evidence.

## T-05: Preferences, accessibility, and read-only MVP certification

**Goal:** Release 1 is configurable, accessible, performant, independently
evaluated, and safe to install without displacing tmux.

**Files:** preference schema/migration, accessibility tests, docs, run evidence.

**Requirements:**

- versioned personal preferences for theme, density, panel geometry, filters,
  time format, motion, update behavior, and non-safety notifications;
- immutable authority/data-integrity/security warnings cannot be hidden by a
  personal preference;
- Release 1 exposes a read-only resolved-run-settings inspector and no editable
  run profile;
- export/import accepts only display settings;
- corrupted preferences reset locally with no server/run effect;
- stable-default-origin restart preserves preferences; explicit port override
  is documented as a separate namespace and migrates only by export/import;
- status uses text/icon plus color; high-frequency telemetry is not an ARIA
  announcement stream;
- full screenshot/DOM matrix and named empty baseline;
- committed `performance-v1.json`/runner fixes corpus, sample counts, warm-ups,
  p95 method, compression, idle sampling, stream workload, and queue bounds;
- performance, security, data-quality, crash-isolation, and legacy regression
  gates in `verify.md` pass;
- README documents local launch, privacy, fallback, and troubleshooting.

**Done when:** Independent exact-SHA evaluator writes a passing eval and the
release candidate remains additive behind `loop web`.

## T-06: Typed message and work-request commands

**Goal:** The browser can submit exactly two typed low-risk intents and recover
their durable receipts without touching a terminal composer.

**Prerequisite:** Read-only MVP observation period and a separately approved
mutation spec.

**Requirements:**

- mode-0600 append-only untrusted command inbox;
- schema, body, auth, CSRF, rate, run revision, epoch, and payload-hash checks;
- server stamps the authenticated actor; client-supplied actor fields fail;
- only current Governess can accept/reject and journal a command;
- `send-message` names a recipient and uses the bridge; `route-task` names a
  requester/result recipient while the router alone chooses the tier/model;
- every Web control/diagnostic consumer uses the persisted socket/server-instance
  adapter context and legacy/reincarnated identity fails closed;
- duplicate, reconnect, stale epoch, Governess-down, and ambiguous dispatch are
  idempotent and fail closed;
- no generic action, shell, file, provider, tmux, or policy endpoint.

**Done when:** The genuine non-empty-composer and duplicate-delivery regressions
pass and every action has a replayable receipt.

## T-07: Lifecycle confirmation controls

**Goal:** Restart, handover, and teardown use a visible two-step, epoch-bound
Governess confirmation state machine.

**Requirements:**

- Governess issues a short-lived single-use challenge bound to run, epoch,
  action, payload hash, and current state;
- browser displays exact target, effect, preservation guarantees, and policy;
- intervening state invalidates the challenge;
- a browser-supplied boolean never counts as confirmation;
- the existing handover state machine and control journal remain authoritative;
- commit/push/merge/deploy/discard remain forbidden.

**Done when:** Multi-tab, replay, stale challenge, partial handover, replacement
failure, and rollback tests pass.

## T-08: Browser-native run profiles and launch

**Goal:** Operators can configure and launch new runs without editing environment
variables while secrets and policy remain server-owned.

**Requirements:**

- typed versioned run profiles and resolved-value/source preview;
- safe validation of agent pair, models, efforts, worktree/tmux, review/proof,
  Governess, workers, and retention;
- new-run settings are distinct from proven live-mutable settings;
- credentials are referenced, never returned or stored in browser exports;
- launch uses existing CLI/manifest/worktree contracts and idempotency.

**Done when:** Preview, invalid profile, duplicate launch, port/worktree/tmux
conflict, secret redaction, and rollback tests pass.

## T-09: Headless Governess and optional tmux adapter

**Goal:** Governess can supervise a run independently of its ANSI pane while
tmux remains an optional renderer and fallback transport.

**Prerequisite:** Explicit founder approval after a defined Web UI parity and
fault-observation window.

**Requirements:**

- extract the Governess tick/state/control runtime from terminal rendering;
- preserve Claude channel, Codex app-server, bridge, and tmux fallback adapters;
- prove restart, delivery, recovery, handover, and evidence parity headlessly;
- keep the terminal renderer attachable and rollbackable;
- change defaults only in a separate release after observation evidence.

**Done when:** Headless/tmux differential replay, live canary, rollback drill,
and independent release review pass.
