# RUNBOOK — loop

> Created by gov-6. This file did not exist before that slice, so it starts with
> the governess beat and grows as later slices add their operational surface.

## Governess beat (gov-6)

The governess beat runs as a Temporal workflow. Its history is the authoritative,
ordered event log, and the JSONL control journal is a read model projected out of
it.

- Workflow type: `governess-beat.v1`
- Workflow id: `governess-beat:<runId>`
- Namespace: `harness`
- Definition: `src/loop/governess-beat-workflow.ts`
- Reducer shared with the JSONL writer: `src/loop/governess-journal-core.ts`

### Turning the Temporal journal on (gov-6 v3)

The live governess writes its journal through the beat workflow only when both
variables are set in the governess pane's environment; with neither set it keeps
the file journal and never loads the Temporal SDK. Setting only one is an error.

```bash
LOOP_GOVERNESS_TEMPORAL_ADDRESS=192.168.1.18:7233
LOOP_GOVERNESS_TEMPORAL_NAMESPACE=harness
LOOP_GOVERNESS_TEMPORAL_TASK_QUEUE=loop-governess   # optional, this is the default
```

- Authority: when both exist, Temporal history is authoritative. The run-dir
  `governess-control.jsonl` stays the synchronous write-ahead copy the governess
  fences against; every record is then signalled (`append_record`, via
  `signalWithStart`) to `governess-beat:<runId>` in order.
- Recovery: on every governess start the file is reconciled from history before
  the epoch is acquired. History wins a disagreement at a held sequence; a file
  that is missing or behind is rewritten from history; a file tail newer than
  history (records the dead pane never signalled) is replayed into history. The
  outcome is logged as `journal-temporal-recovered` in `governess.jsonl`.
- Recovery reads raw history, so it needs the server but not a worker. It waits
  for a settled history (no workflow task in flight, event count stable),
  because Temporal buffers signals that arrive during a workflow task.
- A failed signal is logged as `journal-temporal-append-failed`; later records
  queue behind it and the next start's recovery replays them.
- Live proof: `bun run scripts/governess-temporal-live-proof.ts` with the two
  variables set. It runs its own worker on a private task queue and terminates
  its proof workflow when done.

### One workflow per run, not per seat

The journal's invariants are run-global. The idempotency fence, the monotonic
`sequence` counter, and observation-stream dedupe all key across every seat in a
run. Splitting per seat would shard that fence into independent counters, giving
duplicate sequence numbers with no total order and letting the same idempotency
key pass twice on two different seats. Seat identity travels instead as the
record's `agent` field and inside `observationStream`.

### Inspecting a run

```
loop governess history <run-id>
```

Prints the exported journal read model together with the workflow id and type
that own it. The other governess utility commands are unchanged:

```
loop governess <doctor|replay|explain|history|signals|recover-control-plane> <run-id> [control-id]
```

### Audit contract: metadata only

History carries no prompt bodies.

- Effectful controls cross the boundary as `payloadHash`. The beat workflow
  rejects a `prepare_control` signal that carries a `payload` field, so a body
  cannot reach history even if a caller is careless.
- `payload` is retained only for `observe-runtime`, which is runtime output
  rather than a prompt, and is what lets replay reconstruct decisions.

Callers must hash before signalling. `governess-journal-core.ts` deliberately
imports no Node built-ins — a `node:crypto` import there breaks the webpack
workflow bundle and would drag hashing into the workflow sandbox.

### Changing the beat workflow

The orchestration server registers workflows through the shared bundle, so after
editing `src/loop/temporal-workflow.ts` or any module it pulls in you must
regenerate the bundle or the server keeps running the old code:

```
bun run build:temporal-workflow
```

`LOOP_ORCHESTRATION_WORKFLOW_TYPES` in `src/loop/loop-orchestration-server.ts`
is the declared surface of that bundle.

A new bundle also inherits every execution the old one left running, and
rebuilds each one's state by replaying its history through the new code. Run
`tests/loop/temporal-bundle-replay.test.ts` after any change to that bundle;
what it proves and what it cannot see is under "In-flight Temporal executions
across a bundle change" below.

### Proof suite

`tests/loop/governess-beat-workflow.test.ts` holds the three named checks:

1. deterministic replay — the same fixture reduced twice yields an identical
   decision sequence;
2. journal equality — the exported read model equals the pre-refactor JSONL
   journal, compared by content against a golden generated from the writer at
   commit `80823678` (`tests/fixtures/governess/beat-journal.golden.jsonl`);
3. audit contract — no prompt body appears in any history event or signal
   payload, asserted over the whole event set.

Run it by name:

```
LOOP_TEST_CERTIFICATION_MODE=single-file bun test tests/loop/governess-beat-workflow.test.ts
```

## Retired, awaiting the gov-7 cutover

These are unwired but deliberately not deleted; deletion is the cutover's job.

- `src/loop/dbos-replay-runtime.ts`, `src/loop/dbos-replay-worker.ts`,
  `src/loop/dbos-workflow.ts` — replaced by Temporal replay.
- `src/loop/dbos-workflow-port.ts` — not on gov-6's retire list, but now
  reachable only from retired code.
- `replayGovernessJournal` in `src/loop/governess-replay.ts` — replaced by
  Temporal replay. The rest of that file stays wired: it hosts
  `runGovernessUtilityCommand`, which `src/cli.ts` uses for
  `doctor`/`explain`/`signals`/`recover-control-plane`.

`tests/loop/dbos-workflow-port.test.ts` is the retirement guard: it proves the
retired sources are still present, still marked, and still unwired.

## Known risk to carry into gov-7

One beat workflow per run is a single long-running execution, so its Temporal
history grows without bound over a long run. Event-count limits and a
`ContinueAsNew` boundary need a decision in the cutover slice.

## A2A V2 control plane (r4 integration and round-5 base)

Written 2026-10-06 against claude/fix-integration-r4-2026-10-05 at
00094c661fe6c1923737318d5e39d885d993b11c ("r4"). Updated the same day for
the round-5 base, claude/fix5-base-2026-10-06: r4, plus this runbook
(fc8cd748), plus claude/fix4-recovery-escape-path (26f91ac5, the recovery
quarantine) merged at 0ea648f9, plus the test-fixture fix de5e019d. Neither
r4 nor the round-5 base is merged into main or installed anywhere. A
`file:line` below is a path under `loop-fork/` at 00094c66 unless it is marked
"(round-5 base)", which means at de5e019d. The owner decisions this section
refers to are in `specs/harness-control-plane-vertical-release-v1/decisions.md`
(repository root). Earlier lines it names: 40097564 ("r2", the last line
before the keyed graph id and the deployment discriminator) and ef570282
("r3").

Not on r4 or the round-5 base, so not described here as available: result
graph key rotation with previous keys (claude/fix4-key-rotation, 226e40c2 and
a54a21f4). The recovery quarantine CLI is on the round-5 base only; it is
described under "Recovery quarantine (round-5 base)" below and is not on r4.

### Configuration keys added in rounds 3 and 4

All are optional fields of the `a2aV2` object of the orchestration config.
`a2aV2` keys are checked exactly, so a build that does not know a key refuses
to start with "orchestration a2aV2 has invalid fields"
(src/loop/loop-orchestration-server.ts:412-434).

| Key | Added | Value | Default when omitted | Source |
| --- | --- | --- | --- | --- |
| `resultGraphKeyEnv` | r3 (3cf366e8) | Name of the environment variable holding the result graph HMAC key, never the key itself. The variable must hold at least 32 bytes. | No key: the result-graph route, binding and the CLI refuse. Required when `resultArtifacts` has entries. | loop-orchestration-server.ts:154-160, 509-525, 628-648; supervisor-message-v2-contract.ts:790, 805-813 |
| `readinessOutageBoundMs` | r3 (11b71513) | Whole ms, 1000..86400000. How long a session readiness-store outage may defer a recipient's deliveries before each one fails as a normal retryable attempt. | 900000 (15 min) | loop-orchestration-server.ts:147-152, 560-568; supervisor-message-v2-runtime.ts:84 |
| `workflowIdFormat` | r4 (ae877039) | `"legacy"` or `"deployment"`. The V2 workflow id format new messages are written in. | The format the ledger database records, or `"legacy"` when none is recorded. `"deployment"` is always an explicit opt-in. | loop-orchestration-server.ts:162-175, 578-597; supervisor-message-v2-delivery-ledger.ts:513-562 |
| `notEnrolledBoundMs` | r4 (f3f8c2e1) | Whole ms, 1000..86400000. How long a recipient that is not enrolled may defer its deliveries, measured from when enrollment first failed. | 900000 (15 min) | loop-orchestration-server.ts:132-139, 550-559; supervisor-message-v2-runtime.ts:275 |

Changed in r3: a non-empty `resultArtifacts` without `resultGraphKeyEnv`
refuses startup with "orchestration a2aV2 resultArtifacts requires
resultGraphKeyEnv: ..." (loop-orchestration-server.ts:519-525). An entry in
the retired shape {artifactRef, commit, path, repositoryRoot} refuses startup
with the migration text, and a `graphWorkflowId` that is neither a keyed v3 id
nor an unkeyed v2 id refuses startup (loop-orchestration-server.ts:376-401).
The shape check is a pattern only: a v3 id derived under another key passes
config parsing but can never bind.

A missing key variable refuses startup with "missing orchestration A2A V2
result graph key environment <VAR>"; a short one with "orchestration A2A V2
result graph key environment <VAR> must hold at least 32 bytes"
(loop-orchestration-server.ts:635-647). Both name the variable only.

Retention: session receipt retention (decision 9, c41b459d and 00845464) is
not an orchestration config key. The server always uses the default: per seat,
keep the latest 16 receipts plus every receipt newer than 7 days, pruned in
the seat's next rebind (src/loop/supervisor-session-v2.ts:35-60). `a2aV2`
offers no field for it (loop-orchestration-server.ts:412-434).

Secrets: set the key in the variable named by `resultGraphKeyEnv` through the
host's secret store or protected service environment. Do not put it in the
config file, in a command line or in a log. Generate it with at least 32 bytes
of entropy.

### Workflow id formats

- Legacy: `supervisor-message-workflow:v2:<sha256>`, byte for byte the id the
  pre-discriminator build (40097564) derives (supervisor-message-v2-contract.ts:773-780).
  Rows carry `deployment` NULL.
- Deployment: `supervisor-message-workflow:v2:deployment:<sha256>`, scoped to
  the deployment, which is the host's Temporal task queue
  (supervisor-message-v2-contract.ts:751-763; supervisor-a2a-v2-service.ts:728-733).

In either mode a host reads, recovers and deduplicates both formats: a dedupe
key already recorded under one id keeps it (supervisor-message-v2-delivery-ledger.ts:406-430).

The database records the format in `loop_supervisor_message_v2_schema_marker`,
row `workflow-id-format.v1`, columns `value` and `build_id`. A BEFORE INSERT
trigger, `loop_supervisor_message_v2_start_intent_format_guard_v1`, refuses for
every writer (older builds included) a start intent in any other format, and a
legacy intent for a message already held under a deployment id
(supervisor-message-v2-delivery-ledger.ts:77-101, 513-562).

Every V2 workflow port call checks that the execution runs on this host's
task queue and refuses one on another queue as `WorkflowError (conflict)`
(src/loop/temporal-workflow-port.ts:199-221). That check works in both
formats. In legacy format it cannot refuse a start whose execution does not
exist yet, so hosts on different task queues that share one ledger database
are not isolated (decision 6 is off) until every one of them writes
`"deployment"`.

Start log lines, one per start (supervisor-a2a-v2-service.ts:613-626):

- `A2A V2 workflow ids: legacy format. The deployment discriminator is off: every host sharing this ledger database recovers and deduplicates the others' messages. Set a2aV2.workflowIdFormat "deployment" on every such host once all of them run a build that supports it`
- `A2A V2 workflow ids: deployment format, scoped to this host's task queue`

Startup refusals over the format (supervisor-message-v2-delivery-ledger.ts:526,
540). The service prints them verbatim after "Supervisor A2A V2 service
initialization failed at delivery-ledger: " (supervisor-a2a-v2-service.ts:934-937):

- `V2 delivery ledger records workflow id format "<format>" (written by build <build>), which this build does not support; it supports "legacy" and "deployment". Run a build that supports the recorded format`
- `V2 delivery ledger cannot return to legacy workflow ids: <n> deployment-format start intents have no terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they settle`

A write refused by the trigger raises: `V2 delivery ledger writes "<recorded>"
workflow ids (recorded by build <build>); a "<written>" start intent is
refused. Every host sharing this ledger database must run a build that
supports the recorded format, with the same a2aV2.workflowIdFormat`
(supervisor-message-v2-delivery-ledger.ts:86-89).

### Result graph ids, the result-graph route and the CLI

A message's result graph id is `supervisor-result-graph:v3:<hmac-sha256>`:
HMAC-SHA256 under the host key over ("supervisor-result-graph", "v3", tenant,
principal, messageWorkflowId), each field length-prefixed and NUL-terminated
(supervisor-message-v2-contract.ts:782-856). The retired unkeyed id
`supervisor-result-graph:v2:<sha256>` is still recognised for bindings
recorded before the key; no new binding may name one
(supervisor-message-v2-delivery-ledger.ts:361-371, 741-768).

Compute an id offline, for a `resultArtifacts` entry:

```
loop orchestration result-graph-id <config-path> <message-workflow-id>
```

It reads the config's `a2aV2` tenant, control principal and key variable,
prints only the id, and never starts the server
(src/loop/orchestration-command.ts:5-7, 36-48, 79-89;
loop-orchestration-server.ts:1544-1566). It fails with "orchestration config
has no a2aV2 route" or "orchestration a2aV2 has no resultGraphKeyEnv" when
those are missing.

Start a message's result graph over HTTP, as the control principal (a2aV2
`principal`):

```
POST <a2aV2.routePath>/result-graph
{"input": <task-graph.v1 input>, "messageWorkflowId": "...", "requestId": "..."}
```

The host checks that the message's start intent is recorded in the route's
scope, derives the graph id under its key and starts `task-graph.v1` under it
(supervisor-a2a-v2-service.ts:492-516). Success is 200 with
`{"schema": "supervisor-result-graph-start-receipt.v1", "messageWorkflowId", "graphWorkflowId", "created"}`;
a refused start is 409 `{"code": "result-graph-start-refused"}` with no cause
(src/loop/a2a-supervisor-assignment-http.ts:204-268). The route is mounted at
`<routePath>/result-graph` (loop-orchestration-server.ts:1389-1392).

The old route refuses these ids. `POST /api/v1/task-graphs/start` with a
`workflowId` starting `supervisor-result-graph:` returns 403 with
`error.code` `"result-graph-id-reserved"`, unchanged since r3, and since r4
also `error.message` and `error.replacement`:
`{"method": "POST", "route": "<routePath>/result-graph" or null when the server mounts no A2A V2 route, "body": ["input", "messageWorkflowId", "requestId"], "resultGraphIdCommand": "loop orchestration result-graph-id <config-path> <message-workflow-id>"}`
(src/loop/supervisor-orchestration-http.ts:62-86, 256-261). Ids outside the
prefix start as before. Operator scripts that started result graphs through
task-graphs/start must move to the result-graph route.
`TemporalSupervisorRuntimeHost.httpHandler(authenticator, options?)` takes an
optional `{resultGraphRoutePath?: string}`; one-argument callers are unchanged
(src/loop/temporal-supervisor-runtime.ts:325-334).

Bind a result (unchanged route, keyed check since r3): `POST
<routePath>/assignment` with {a2aTaskId, graphTaskId, graphWorkflowId,
messageWorkflowId, recipient}. The graph must equal the keyed id of the
message and be listed in `resultArtifacts`. Any refusal is 409
`{"code": "assignment-refused"}` (a2a-supervisor-assignment-http.ts:127-195;
supervisor-a2a-v2-service.ts:419-490).

### Health and status surfaces

Unauthenticated `GET /healthz` carries counts and aggregate state only, no
seat or recipient id (loop-orchestration-server.ts:255-282):

```
{
  "schema": "loop-orchestration-health.v1",
  "state": "ready" | "unavailable",
  "notEnrolledCount": <n>,
  "a2aV2NotEnrolledDeferral": {"boundMs", "deferredDeliveries", "notEnrolledFailures", "recipientsDeferred"},
  "a2aV2ReadinessOutage": {"boundMs", "deferredDeliveries", "outageFailures", "recipientsDeferred"}
}
```

The two `a2aV2*` blocks appear only when an A2A V2 service is mounted.
`notEnrolledCount` is always supplied by the server (loop-orchestration-server.ts:1725-1731).
`state` ignores both deferrals. Counters are cumulative since process start;
each `recipientsDeferred` is a current count
(supervisor-message-v2-runtime.ts:114-131, 244-259, 310-321, 408-420). On r3
the body carried `notEnrolled` with seat ids instead of `notEnrolledCount`; a
consumer reading `notEnrolled` must read `notEnrolledCount` or the
authenticated status below.

Authenticated `GET <routePath>/assignment`, control principal only, returns
`{"schema": "supervisor-result-assignment-status.v1", "notEnrolled": [seat ids], "readinessOutage": [recipient ids], "unpublishable": [...]}`
(a2a-supervisor-assignment-http.ts:66-108; supervisor-a2a-v2-service.ts:628-664).
`unpublishable` lists this tenant's bindings recorded before graphs were
derived (`body-chosen-graph`) or unreadable (`malformed`). It does not list a
binding stranded by a key change (see rotation below).

On the round-5 base the same GET also carries `"recoveryQuarantine": [...]`:
this tenant's records an operator quarantined from recovery, each as
`{"at", "by", "reason", "recipient", "workflowId"}` (round-5 base:
a2a-supervisor-assignment-http.ts:72-128; supervisor-a2a-v2-service.ts:633-675).
A quarantine never appears on /healthz, not even as a count (owner question Q2
is open). A failing read of any section answers 503
`{"code": "status-unavailable"}` with no cause.

Readiness outage semantics (d6392ce9, supervisor-message-v2-runtime.ts:145-171):
the bound is measured from the first failure a delivery observed for that
recipient. An outage ends when the store answers for that recipient, or when
no delivery observed it for 2 hours and no message it failed still waits on
its retry. `recipientsDeferred` and the `readinessOutage` list include only
recipients observed in an outage within the last 2 hours. A later, separate
outage gets its own bound. State is in memory, so a restart starts the bound
again. Log lines: `V2 delivery to <recipient> deferred: session readiness store is unavailable`,
`... still deferred after <bound>ms: the readiness store outage now fails delivery attempts`,
`... resumed after <ms>ms: session readiness store answered`
(supervisor-message-v2-runtime.ts:196-237).

Not-enrolled deferral (f3f8c2e1): a peer seat that is not running or not
reachable degrades that seat alone at start; the configured recipient's own
failure, or any other peer failure, still refuses start
(loop-orchestration-server.ts:936-978, 1053-1077). Log lines:
`orchestration A2A V2 session enrollment failed for <seat>: <cause>` and
`orchestration A2A V2 session enrollment recovered for <seat>`
(loop-orchestration-server.ts:1228-1247); `V2 delivery to <recipient> deferred: recipient session is not enrolled`,
`... still deferred after <bound>ms not enrolled: delivery attempts now fail`,
`... resumed after <ms>ms: recipient session is enrolled and ready`
(supervisor-message-v2-runtime.ts:365-406).

### Recovery at start (decision 7)

Service-start recovery skips only a record whose id is held by an execution
this deployment does not own, logging `V2 recovery skipped workflow <id> for <recipient>: WorkflowError (conflict): ...`.
Any other per-record failure, or a failure of the whole sweep, refuses
startup after every other record was recovered
(supervisor-message-v2-runtime.ts:543-556, 640-662, 735-740). The periodic
sweep retries a failing record with backoff min(interval x 2^(n-1), 10 min)
and logs each transition (supervisor-message-v2-runtime.ts:697-733).

Two limits on r4, both fixed on the round-5 base (next subsection):

- The refusal reaches the operator only as `Supervisor A2A V2 service initialization failed at runtime-host (unclassified)`.
  `SupervisorMessageV2RecoveryStartupError` names every failing record, but it
  is not on the service's list of reportable error names and the runner does
  not log it (supervisor-a2a-v2-service.ts:316-327, 939-942;
  supervisor-message-v2-runtime.ts:652-661). r4 has no way to start past such
  a record. On r4, find the record by its own symptom (database or Temporal
  error) and repair it before restarting.
- A conflict at start counts as foreign whatever its cause. That includes an
  execution of another workflow type on this host's own task queue: the port
  raises `WorkflowError (conflict): workflow <id> already exists as <type>`
  (temporal-workflow-port.ts:150-156), and recovery skips it. On r4 the test
  "the orchestration server starts when a recorded V2 workflow ID is held by
  a foreign execution" (tests/loop/loop-orchestration-server-postgres.test.ts)
  pins that skip for a running `supervisor-message.v1` execution on the same
  queue.

### Recovery quarantine (round-5 base)

On the round-5 base (merge 0ea648f9 of claude/fix4-recovery-escape-path,
26f91ac5), recovery at start changes in three ways. Paths below are at the
round-5 base.

- Only an execution on another task queue is foreign. The port raises it as
  `WorkflowForeignExecutionError`, still a `WorkflowError (conflict)` with
  the message `workflow <id> belongs to another task queue`
  (temporal-workflow-port.ts; workflow-port.ts), and recovery skips only that
  (supervisor-message-v2-runtime.ts:503-511). Another workflow type under a
  recorded id on this host's own queue is a failure: running, the port's
  start refuses the type; closed, the coordinator refuses any status answer
  that is not a `supervisor-message-status.v2` projection, so the other
  type's state is never recorded as this message's terminal outcome
  (supervisor-message-v2-runtime.ts:1552-1564).
- A refused start names each failing record and the exact command that
  quarantines it, and the runner logs it as well
  (supervisor-message-v2-runtime.ts:543-567, 777-787):
  `V2 initial recovery failed for <n> recorded start(s): workflow <id> for <recipient>: <error> [to start without it: loop orchestration v2-quarantine <config-path> <id> --reason '<why>']`.
  The service reports the class:
  `Supervisor A2A V2 service initialization failed at runtime-host (SupervisorMessageV2RecoveryStartupError)`
  (supervisor-a2a-v2-service.ts:320-331). A start intent row that cannot be
  read at all fails the whole sweep; at start it is refused the same way, by
  its workflow id, with the recipient shown as `an unreadable recipient`
  (supervisor-message-v2-runtime.ts:740-757).
- An operator can quarantine such a record explicitly and durably. Recovery
  then leaves it alone, does not retry it, and logs at every start
  (supervisor-message-v2-runtime.ts:789-818):
  `V2 recovery QUARANTINED workflow <id> for <recipient>: skipped until released (quarantined by <by> at <at>: <reason>); release it with: loop orchestration v2-quarantine-release <config-path> <id> --reason '<why>'`.
  A release is logged once, `V2 recovery quarantine of workflow <id> for <recipient> was released; recovering it again`,
  and the record is recovered as any other from the next sweep.

Commands (src/loop/orchestration-command.ts:7-16, 43-111; loop-orchestration-server.ts:1570-1664):

```
loop orchestration v2-quarantine <config-path> <workflow-id> --reason <text> [--by <operator>]
loop orchestration v2-quarantine-release <config-path> <workflow-id> --reason <text> [--by <operator>]
loop orchestration v2-quarantine-list <config-path>
```

- `--by` defaults to the operating-system user running the command. `by` is
  1-200 characters and `reason` 1-1000, with no control characters.
- The command reads the config, takes the database URL from the environment
  variable named by `a2aV2.databaseUrlEnv`, and opens this deployment's
  ledger (its `taskQueue`) as the server does: the config's `buildId` and
  `a2aV2.workflowIdFormat`. Every one of the three commands, the list
  included, runs the server's full migrations: the additive DDL, the format
  marker write and, in legacy format, the legacy-id backfill. So on a
  database with no format marker it records what the server's first start
  would. Do not run any of them with a config whose `workflowIdFormat`
  differs from the one the running hosts use: like a server start, it would
  record the config's format, and the guard trigger would then refuse the
  running hosts' new start intents. Use the running hosts' own config. It
  never starts the server. Whether these commands should leave the format
  alone is an open owner question.
- Output names workflow ids, recipient, who, when and why, never the database
  URL: `quarantined <id> for <recipient> by <by> at <at>: <reason>`,
  `already quarantined ...` (the first quarantine stands, unchanged),
  `released <id> for <recipient> (quarantined by <by> at <at>: <reason>)`,
  and for the list `<id> for <recipient> quarantined by <by> at <at>: <reason>`
  or `no quarantined V2 recovery records`.
- Refusals: `V2 workflow <id> has no start intent recorded by this deployment`
  (another deployment's record, or none), `V2 workflow <id> already has a
  terminal outcome; recovery leaves it alone`, `V2 workflow <id> is not
  quarantined` (release), `missing orchestration A2A V2 database environment
  <VAR>`, and `orchestration A2A V2 ledger is unavailable` for any connection
  or migration failure (no cause, which may carry credentials). A workflow id
  format refusal is printed as `orchestration A2A V2 ledger refused: ` followed
  by the exact ledger message listed under "Workflow id formats".
- Only an open start intent of this deployment, its own or a legacy one
  (`deployment` NULL), can be quarantined, readable or not. A legacy row is
  recovered by every deployment sharing the database, and each deployment
  quarantines it separately.

Quarantine and workflow id formats: a quarantine is not a terminal outcome,
and recovery never settles a quarantined record. A quarantined
deployment-format record therefore counts as unsettled, and every start with
`a2aV2.workflowIdFormat` `"legacy"` (or none) is refused with "cannot return
to legacy workflow ids" until the record is released and recovery records
its outcome; releasing it is not enough. No outcome can be recorded by hand
(owner question). So while a deployment-format record is quarantined, a
return to legacy ids, including a rollback to the legacy-write default, is
blocked. Plan the release before planning that rollback.

Storage: table `loop_supervisor_message_v2_recovery_quarantine`, one active
row per (workflow id, deployment); a release keeps the row with who, when and
why as history (supervisor-message-v2-delivery-ledger.ts:566-584, 1015-1110).
Status: the authenticated assignment GET lists this tenant's quarantines (see
"Health and status surfaces"). A deployment without an assignment route has
only the start-time log lines and `v2-quarantine-list`, which needs the
database credential.

Rollback and mixed versions: the table is additive. A build without it (r4,
r3) ignores it, so it refuses startup on a quarantined failing record again
and loses the escape. It also restores the r3/r4 handling of a same-queue
workflow-type conflict: a running one is skipped as foreign, and a closed
one is durably recorded as `terminated` from the other type's status. That
record is not undone by upgrading again. Before rolling back, resolve each
same-queue conflict the round-5 base reported.

### What existing rows and bindings do on upgrade

All migrations run in `migrate()` on the first start and are additive
(supervisor-message-v2-delivery-ledger.ts:432-496):

- Start intents written before the discriminator keep their legacy id with
  `deployment` NULL. Nothing is rewritten or backfilled.
- `terminal_outcome` is not backfilled (decision 5). Existing rows read NULL,
  meaning no outcome observed. A closed execution Temporal still holds gets
  its marker on the next recovery sweep. An execution purged before the
  marker existed, with no completed delivery, cannot be told from a lost
  start and is restarted.
- A database migrated by the 3f7a70f2 build: inside one transaction holding
  ACCESS EXCLUSIVE on `loop_supervisor_message_v2_start_intent`, migrate
  decides whether the `terminal_outcome` CHECK is current. It is current when
  one exists, no CHECK allows `'completed'`, and every CHECK allows every
  current outcome; a CHECK widened to a superset of the current list (for
  example by a newer build) is therefore current. A current CHECK is left in
  place: the step takes the lock briefly and changes nothing. Otherwise (the
  3f7a70f2 CHECK, a missing CHECK, or one missing a current outcome) every
  `terminal_outcome` CHECK is dropped, stored `'completed'` is rewritten to
  `'acknowledged'`, and the CHECK
  `loop_supervisor_message_v2_start_intent_terminal_outcome_check` over
  ('acknowledged', 'canceled', 'dead-lettered', 'exhausted', 'terminated') is
  added. Only in that replacement case can migrate fail: if a stored value is
  outside the current list, adding the CHECK fails and so does migrate
  (supervisor-message-v2-delivery-ledger.ts:590-632).
- Result bindings recorded under the unkeyed v2 graph of their own message
  are reserved once (marker `result-graph-task-backfill.v1`), keep publishing
  and stay immutable. Bindings that named a body-chosen graph, or cannot be
  read, are recorded once in `loop_supervisor_message_v2_unpublishable_result_binding`,
  logged at every start as `A2A V2 result binding will never publish (<reason>): tenant <T> message <M> A2A task <A>; re-bind it to its message-derived result graph`,
  and listed by the authenticated assignment GET. Re-binding the message to
  its keyed graph clears the entry
  (supervisor-message-v2-delivery-ledger.ts:634-699, 836-846;
  supervisor-a2a-v2-service.ts:590-604).
- Temporal graphs already started under a v2 id keep running; nothing is
  renamed.
- A database written by the r3 build has deployment-format rows and no
  format marker. It defaults to `"legacy"`, so start is refused with the
  "cannot return to legacy" message until `"deployment"` is set or its rows
  settle.
- Session receipts are not rewritten. Each seat's backlog is pruned at that
  seat's first rebind. The first migrate builds two seat indexes with plain
  CREATE INDEX, which blocks receipt writes while each index builds
  (supervisor-session-v2.ts:634-647).
- Round-5 base only: migrate also creates the empty
  `loop_supervisor_message_v2_recovery_quarantine` table and its partial
  unique index (round-5 base: supervisor-message-v2-delivery-ledger.ts:566-584).
  Nothing existing is rewritten.

### In-flight Temporal executions across a bundle change

Checked 2026-10-07 on claude/fix5-temporal-replay, from the round-5 base
c7646ed353ae2b2d7df0da17bd3d7c486a9209d5, by
`tests/loop/temporal-bundle-replay.test.ts` (29 tests, all pass, about 40 s,
needs the Temporal dev server and the commits 40097564 and ef570282 in the
clone; it fails rather than skips without them).

How these executions run: every V2 message and task graph is one execution
of the single Temporal workflow `temporalWorkflow`
(src/loop/temporal-workflow.ts). It keeps the message or graph state machine
in memory, never returns, and issues no Temporal commands (no activity, timer
or child). A message that is acknowledged, dead-lettered or exhausted, or a
graph that completed or failed, stays a RUNNING execution until something
terminates it. A worker on a new bundle rebuilds each execution's state by
replaying its start input and every signal through the new code.

What was tested. Histories recorded by the shipped (committed generated)
bundles of 40097564 and ef570282, each driven by that commit's own workflow
port and id derivations (fixtures in `tests/fixtures/temporal-replay`,
regenerated by `bun run scripts/record-temporal-replay-histories.ts`), eleven
in-flight executions per commit: V2 delivery pending with a refused early
claim; V2 in retry backoff; V2 delivered after a retry and waiting for its
claim; V2 claimed and waiting for acknowledgement; V2 acknowledged; V2
dead-lettered; a gated graph task waiting for its authority receipt; a ready
task waiting for a claim; a message's result graph with its task running and
waiting for the result; a graph with its first task done and the dependent
claimed; a graph whose first task failed and blocked the dependent.

Results:

- Replay (`Worker.runReplayHistories`): all 22 histories replay without error
  on this line's shipped bundle (code digest 2af18dc4...) and on a fresh build
  of its source.
- Live handoff on a local Temporal server, for 40097564 to this line,
  ef570282 to this line, and this line to 40097564 (the rollback target): the
  old bundle's worker leaves the eleven executions in flight; a worker on the
  other bundle, with no cache so every task replays the whole history, answers
  every inspection, status and command-outcome query exactly as before the
  switch; finishing the work there ends in the same state as finishing it on
  the old bundle; no workflow task fails; the mixed histories replay.

So no drain is needed for V2 message and task graph executions when
upgrading from 40097564 or ef570282 to this line, and at the workflow layer
none is needed to roll back to 40097564. Not covered: governess beat
journal executions, V1 supervisor messages, escalation through `clock_tick`
(V2 never sends it) and cancel.

What Temporal's own replay check cannot see here (mutation runs on
2026-10-07, each reverted):

- A change in what a signal does (the retry delay doubled) replayed clean;
  only the live handoff caught it (the retry fell due at a different time).
  In-flight state would have changed silently.
- An added command (a timer before the wait) also replayed clean, and the
  forward handoffs passed: the histories hold no command events for it to
  contradict. Only the rollback handoff failed, with `[TMPRL1100]
  Nondeterminism error: No command scheduled for event ... TimerStarted`. An
  added command makes rollback across it unsafe for executions it touched.
- A start or signal the new code refuses fails replay (a task graph limited to
  one node failed the six two-node graph histories).

Draining is not available as a fallback: these executions never complete, so
emptying them means terminating them, which V2 recovery records as
`terminated`. A future change that fails this test therefore needs a
replay-safe form (Temporal `patched()` around the new behaviour, or a new
workflow type) rather than a drain.

The 40097564 committed bundle is not a build of its own source: the
supervisor-message-v2-contract and supervisor-message-v2-runtime modules
differ (exports, a named constant, the result graph derivation and recovery
logging, none of it run inside the workflow). The tests use the committed
bundle, which is what a 40097564 host runs. ef570282 and this line's committed
bundles match their source.

### Upgrade procedure

Conservative path: rolling back stays possible until an explicit flip. The
steps name r4; they apply unchanged to the round-5 base, whose only additions
are the quarantine table, the quarantine commands and the `recoveryQuarantine`
section of the assignment GET. No config key was added after r4.

1. Before: back up the ledger database. Stop every host that shares it, or
   plan one host at a time knowing that a host whose format another host
   changed refuses to record until it restarts. On the candidate checkout run
   `bun run test:file tests/loop/temporal-bundle-replay.test.ts`; all 29 pass
   on the round-5 base, so in-flight V2 messages and task graphs need no
   drain. If the candidate is not the round-5 base and any of them fails, do
   not upgrade with executions in flight (see "In-flight Temporal executions
   across a bundle change").
2. Config, on every host: if `resultArtifacts` has entries, add
   `resultGraphKeyEnv` and provide the key through the secret store.
   Recompute each entry's `graphWorkflowId` with `loop orchestration
   result-graph-id`. An entry for a binding recorded under its unkeyed v2 id
   may keep that id. Leave `workflowIdFormat` unset (legacy write).
   Optionally set `readinessOutageBoundMs` and `notEnrolledBoundMs`.
   Exception: from an r3-written database, set `workflowIdFormat`
   `"deployment"` now, or start is refused while its deployment rows are
   unsettled.
3. Start every host on r4.
4. Verify on each host: the legacy-format start line; `GET /healthz` reports
   `state` "ready" and `notEnrolledCount`; the authenticated `GET
   <routePath>/assignment` answers; any "will never publish" lines are
   expected and listed. In the database:
   `SELECT value, build_id FROM loop_supervisor_message_v2_schema_marker WHERE name = 'workflow-id-format.v1'`
   returns `legacy` and this build's id.
5. Flip, optional and pending owner question Q1: only after every host that
   shares the database runs r4, set `workflowIdFormat` `"deployment"` on every
   one of them and restart each. Verify the deployment-format start line and
   the marker value `deployment`. From then on 40097564 can record nothing
   on this database and its recovery refuses deployment-format rows.

### Rollback procedure

- Before the flip (marker `legacy`, and the database never held a
  deployment-format row), to 40097564: stop the r4 hosts. Restore the 40097564
  config: remove `resultGraphKeyEnv`, `readinessOutageBoundMs`,
  `workflowIdFormat` and `notEnrolledBoundMs`, and any `resultArtifacts`
  entry naming a v3 id (40097564 refuses all of them). Start 40097564.
  This is safe for the workflow id path (ledger test "rollback: the real
  base-era ledger migrates, recovers, deduplicates and records over default
  legacy-write rows, and this build reads its rows back"). Limits: results
  bound under keyed v3 graphs are not published by 40097564, which lets the
  message be re-bound to its unkeyed v2 graph (ledger test "rollback limit:
  ..."); 40097564 refuses start when any configured seat cannot be enrolled;
  its /healthz carries only `schema` and `state`. With V2 executions still
  running: at the Temporal workflow layer, executions this line started
  continue on 40097564 exactly as here (temporal-bundle-replay, handoff
  "current left in flight continue on r2-40097564"). How 40097564's
  coordinator and recovery treat those running messages against
  legacy-write rows is not tested with running executions; the ledger
  rollback test above covers the rows alone.
- After the flip: set `workflowIdFormat` `"legacy"` on r4 and restart.
  Start is refused while any deployment-format start intent has no terminal
  outcome. If rows never settle (for example rows of a task queue that no
  longer runs), run a host on that task queue in `"deployment"` mode until
  its recovery settles them; otherwise stay on `"deployment"`. No override
  exists. On the round-5 base a quarantined deployment-format record never
  settles: release it and let recovery record its outcome first (see
  "Recovery quarantine (round-5 base)"). After a flip, 40097564 is not a
  rollback target.
- To ef570282 (r3): not recommended. By code reading, untested: r3 always
  writes deployment-format intents (ef570282
  supervisor-message-v2-delivery-ledger.ts:636-664), so with the marker at
  `legacy` the trigger refuses every new message r3 receives. r3 also puts
  seat ids back on unauthenticated /healthz (`notEnrolled`). Its config must
  drop `workflowIdFormat` and `notEnrolledBoundMs`.
- From the round-5 base to r4 (or to any older build): every limit above
  applies, plus those under "Recovery quarantine (round-5 base)": the older
  build ignores quarantines, so a quarantined failing record refuses its
  start again, and a closed same-queue workflow-type conflict is recorded as
  `terminated`. Before rolling back, resolve the cause of every quarantined
  record (`loop orchestration v2-quarantine-list <config-path>`) and every
  same-queue conflict; a record that still fails refuses the older build's
  start.

### Result graph key rotation on r4

r4 holds one key and has no previous-key support. Rotating the key changes
every v3 id. Verified at the ledger level on 2026-10-06 with a throwaway test
(not committed) on real PostgreSQL, and by the committed test "no new binding
may name an unkeyed v2 graph, and a ledger without the key binds nothing":

- A binding recorded under the old key stops publishing under the new key.
  Nothing reports it: it is not in the unpublishable table, the start log or
  the assignment GET.
- Re-binding the same A2A task to its new-key graph replaces the old binding,
  and it publishes again. A host still holding the old key then no longer
  publishes it.

Procedure, if a rotation cannot wait for claude/fix4-key-rotation:

1. Drain: wait until every bound result has been published, so no binding is
   pending under the old key. r4 offers no listing of keyed bindings; check
   the A2A tasks you bound.
2. Put the new key in the secret store (a new variable name, or the same
   one), update `resultGraphKeyEnv` if the name changed, and recompute every
   `resultArtifacts` `graphWorkflowId` with `loop orchestration
   result-graph-id`. Old v3 ids still pass config parsing, so startup does not
   catch a stale entry.
3. Restart. For any message still pending under the old key, start its graph
   again with `POST <routePath>/result-graph`, add the returned
   `graphWorkflowId` to `resultArtifacts`, restart, and re-POST the
   assignment with it. The old graph's Temporal execution keeps running.

### Proof by test file

On 2026-10-06 at 00094c66 with task-owned PostgreSQL and Temporal
(`bun run test:file`): orchestration-command 4, supervisor-orchestration-http
10, a2a-supervisor-assignment-http 8, loop-orchestration-server 33,
bridge-result-reply-dedupe 16, supervisor-message-v2-runtime 32,
supervisor-message-v2-recovery 34, supervisor-session-v2 7,
supervisor-session-v2-postgres 13, supervisor-a2a-result-binding 11,
supervisor-message-v2-delivery-ledger 42,
supervisor-message-v2-temporal-retention 12,
loop-orchestration-server-postgres 15, temporal-orchestration-e2e 2,
temporal-workflow-port 12 and temporal-supervisor-runtime 8 tests, all pass.
supervisor-a2a-v2-service: 12 pass, 1 fail on both runs: "every V2 delivery
path of one service defers a not-enrolled recipient under one shared bound,
log line, and counters". Its fixture passes `host: {taskQueue}` with no
`buildId`, which the ledger requires since ae877039, so the service fails at
"delivery-ledger (unclassified)". The test came from f3f8c2e1 and the
requirement from ae877039; they first meet on r4. It is a test-fixture
defect: the server always passes the config's required `buildId`
(loop-orchestration-server.ts:1321).

Round-5 base, 2026-10-06 at de5e019d, whole suite file by file with
task-owned PostgreSQL and Temporal: 2533 tests, 2516 pass, 17 fail, and all
17 fail at r4 too, outside the A2A V2 area (loop.test, tmux,
governed-supervisor-message, native-subagent, seat-pane-identity,
utility-composed-release). The not-enrolled test above passes: de5e019d gives
its fixture a host `buildId` and the `"deployment"` workflow id format; a
`buildId` alone still failed at recordStartIntent, because the test runs its
message under a deployment-scoped id. Quarantine files: orchestration-command
7, a2a-supervisor-assignment-http 9, supervisor-message-v2-recovery 43,
supervisor-message-v2-delivery-ledger 45, loop-orchestration-server-postgres
16, supervisor-a2a-v2-service 13, supervisor-a2a-result-binding 11, all
pass.

2026-10-07 on claude/fix5-temporal-replay (round-5 base plus the replay
tests), with a task-owned Temporal dev server: temporal-bundle-replay 29 tests,
all pass (2 fixture checks, 22 history replays, 2 replay controls, 3 live
handoffs).
