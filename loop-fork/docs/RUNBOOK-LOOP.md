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

Not on r4 or the round-5 base: result graph key rotation with previous keys.
It is on claude/fix5-key-rotation, the round-5 base plus a port of
claude/fix4-key-rotation (226e40c2, a54a21f4) and the fixes for its two
round-4 review majors. It is described under
"Result graph key rotation (claude/fix5-key-rotation)" below; a `file:line`
there is a path under `loop-fork/` on that branch. The recovery quarantine
CLI is on the round-5 base only; it is described under "Recovery quarantine
(round-5 base)" below and is not on r4.

The round-5 integration line, claude/fix-integration-r5-2026-10-06 at
9b3dca36 ("r5 integration"), is the round-5 base (c7646ed3) plus three
merges: claude/fix5-key-rotation (41c4c1a2, merge 8e965197),
claude/fix5-rollback-to-deployed (f148d386, merge 76a1fa32) and
claude/fix5-temporal-replay (c2ea0eae, merge 9b3dca36). It is not merged
into main and not installed. On it, everything said below of
claude/fix5-key-rotation holds: `loop-fork/src` is identical at 41c4c1a2 and
9b3dca36 (`git diff --stat 41c4c1a2 9b3dca36 -- loop-fork/src` is empty), so
the `file:line` references of that branch apply. The replay test
(`tests/loop/temporal-bundle-replay.test.ts`) and the rollback test
(`tests/loop/orchestration-rollback-to-deployed.test.ts`) exist only on their
branches and on r5 integration, not on the round-5 base.

### Configuration keys added in rounds 3 to 5

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
| `previousResultGraphKeyEnvs` | claude/fix5-key-rotation (41c4c1a2) and r5 integration (merge 8e965197); not on r4 or the round-5 base | One to eight distinct names of environment variables, each holding a result graph key this host held before `resultGraphKeyEnv` (at least 32 bytes each). Requires `resultGraphKeyEnv`; none may be its name, and no two variables may hold the same key. | No previous key. | that branch: loop-orchestration-server.ts:416-447, 703-744 |

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
derived (`body-chosen-graph`) or unreadable (`malformed`). On r4 and the
round-5 base it does not list a binding stranded by a key change (see
rotation below); on claude/fix5-key-rotation it does, and the GET also
carries `underPreviousResultGraphKey` (see "Result graph key rotation
(claude/fix5-key-rotation)").

On the round-5 base the same GET also carries `"recoveryQuarantine": [...]`:
this tenant's records an operator quarantined from recovery, each as
`{"at", "by", "reason", "recipient", "workflowId"}` (round-5 base:
a2a-supervisor-assignment-http.ts:72-128; supervisor-a2a-v2-service.ts:633-675).
A quarantine never appears on /healthz, not even as a count. (Owner decision
2026-10-09, Q2: unauthenticated /healthz carries no seat ids. A quarantine
count there was not part of that decision; none is added.) A failing read of
any section answers 503 `{"code": "status-unavailable"}` with no cause.

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
(owner decision 2026-10-09: no hand-recorded terminal outcomes). So while a
deployment-format record is quarantined, a return to legacy ids, including a
rollback to the legacy-write default, is blocked. Plan the release before
planning that rollback.

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

Checked 2026-10-09 on claude/fix6-replay-coverage, from the round-5
integration branch claude/fix-integration-r5-2026-10-06 (9b3dca36, shipped
bundle code digest 0e061109...), by `tests/loop/temporal-bundle-replay.test.ts`
(74 tests, all pass, about 140 s). It needs the Temporal dev server and the
commits 40097564, ef570282, 00094c66, c7646ed3 and 4439b2e7 in the clone,
and fails rather than skips without them (owner decision 2026-10-09: a
shallow clone fails). The 2026-10-07 run (29 tests, r2 and r3 only, V2
messages and task graphs only) is recorded below it.

How these executions run: every V2 message, V1 message, governess beat and
task graph is one execution of the single Temporal workflow
`temporalWorkflow` (src/loop/temporal-workflow.ts). It keeps the state
machine in memory, never returns, and issues no Temporal commands (no
activity, timer or child). A message that is acknowledged, dead-lettered,
canceled or exhausted, or a graph that completed or failed, stays a RUNNING
execution until something terminates it; a governess beat never ends. A
worker on a new bundle rebuilds each execution's state by replaying its
start input and every signal through the new code.

What was tested on 2026-10-09. Histories recorded by the shipped bundles of
five builds, each driven by that commit's own workflow port and id
derivations (fixtures in `tests/fixtures/temporal-replay`, schema
`temporal-replay-fixtures.v2`, regenerated by `bun run
scripts/record-temporal-replay-histories.ts`):

- the V2 line: 40097564 (r2), ef570282 (r3), 00094c66 (r4) and c7646ed3
  (the round-5 base), the eleven V2 message and task graph executions listed
  below, each;
- 455ccc32, the build of the live orchestration service (`loop-ed33f43f`),
  which has no V2 code: sixteen executions of its own workflow types. V1
  messages: delivery pending with a refused early claim; retry backoff with
  a `clock_tick` before the retry is due; delivered after `retry_due` and
  waiting for its claim; escalated by `clock_tick` past its claim deadline;
  dead-lettered by `clock_tick` past its escalation deadline; claimed;
  acknowledged; dead-lettered by a permanent failure; canceled. Governess
  beats: the write-through path (`append_record`, as
  governess-temporal-journal.ts sends it), with a control dispatched and
  waiting for acceptance, a resend, a conflicting record and a sequence gap
  refused; the gov-6 decision path (`record_observation`, `prepare_control`,
  `transition_control`) with a restart dispatched, a prompt body refused,
  then failed, re-prepared under its closed fence and refused a completion.
  The five task graphs, with a plain graph in place of the result graph.

Every snapshot now holds every query the callers send, or the error it
fails with, besides the inspection and every command outcome: `status`,
`delivery_pending` and `delivery_request` for V2 (what the V2 coordinator
and recovery read before each delivery), `status`, `delivery_request` and
`event_kinds` for V1, `status` and `ready` for task graphs, `journal`,
`pending_controls` and `latest_by_idempotency` for the governess beat.

Results (2026-10-09):

- Replay (`Worker.runReplayHistories`): all 60 histories replay without
  error on this line's shipped bundle and on a fresh build of its source.
- Recorded answers (new): each recorded history's start input and signals,
  sent again byte for byte to a worker on this line's bundle (shipped, and
  built from source), leave every query answer, the inspection and every
  command outcome exactly as the recording build answered them. This check
  needs only the fixtures, not the old commits.
- Live handoffs, both ways: r2, r3, r4, the round-5 base and 455ccc32 to
  this line, and this line to r2 and to 455ccc32 (the rollback targets):
  every answer on the new worker equals the old one's, ids included;
  finishing there ends as finishing on the old bundle (V2 delivery ids
  masked, since subject and control are different messages); no workflow
  task fails; the mixed histories replay.
- 455ccc32 is on no remote, so the fixtures are recorded from it, but the
  live tests extract 4439b2e7 (an ancestor of this line), which commits the
  same generated bundle blob (cebd34d4) and workflow port blob (355e9095).
  The recorder checks both blobs; the live test checks the extracted bundle
  against the code digest recorded from 455ccc32 (5adf5715...). Pointing it
  at dde60215 instead fails that check (mutation run).
- Module by module, 455ccc32's committed bundle is a build of its own source
  once build-machine paths are ignored (it was built with node_modules in
  `../../governess-helper-env/loop-fork/`), and it differs from this line's
  bundle only in the V2 modules, `temporal-workflow.ts` (the V2
  registration) and `workflow-port.ts`. The V1 message, governess beat,
  governess journal core and task graph modules are the same code.

So no drain is needed for V2 messages and task graphs when upgrading from
any V2 build here, nor for the live service's V1 messages, governess beats
and task graphs when it is upgraded to this line; at the workflow layer none
is needed to roll back to r2 or to 455ccc32. Still not covered: a V2
cancel (V2 recovery never sends one), V2 escalation (V2 never sends
`clock_tick`), and governess beat histories written by the live journal
itself rather than by these scenarios.

Mutation runs on 2026-10-09, each with the bundle rebuilt and both reverted,
against this test and against the 2026-10-07 version of it:

- V2 `delivery_request` naming the next attempt one too high, and V2
  `delivery_pending` ignoring the delivery status: neither changes a status
  projection, an inspection or an outcome. The 2026-10-07 test passes (29 of
  29); this one fails the recorded answers on both bundles and the five V2
  handoffs (7 fail).
- V1 escalation only after, not at, the claim deadline: replay passes; the
  recorded answers and both 455ccc32 handoffs fail (4 fail).
- Governess `pending_controls` in reverse order, a query-only change:
  replay passes; the recorded answers and both 455ccc32 handoffs fail.
- Task graph `ready` listing every task that is not pending: replay
  passes; the recorded answers and all seven handoffs fail (9 fail).

What was tested on 2026-10-07. Histories recorded by the shipped (committed generated)
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

Results (2026-10-07):

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

So no drain was needed for V2 message and task graph executions when
upgrading from 40097564 or ef570282, and at the workflow layer none was
needed to roll back to 40097564. Not covered on 2026-10-07 (governess beats,
V1 messages, `clock_tick` escalation and a V1 cancel are covered since
2026-10-09, above).

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
- A start the new code refuses fails replay (a task graph limited to one
  node failed the six two-node graph histories, with or without the bundle
  regenerated).
- A signal the new code refuses does not. Corrected 2026-10-09: this bullet
  said a refused signal fails replay too, which no mutation run had tested.
  `temporalWorkflow` applies every signal inside a try/catch and records a
  refusal (any error the workflow definition throws) as that command's error
  outcome (src/loop/temporal-workflow.ts, `applyCommand`), so the workflow
  task succeeds and the history replays. Mutation runs on 2026-10-09 at
  9b3dca36, each reverted: every task graph `claim` refused, and every V2
  message `claim` refused, each with the bundle regenerated. All 22
  histories replayed clean on both bundles; only the three live handoffs
  failed, because the command outcome and the state differ. In-flight state
  would change silently. The test's control fails replay only because its
  signal handler throws out of the workflow task
  (tests/fixtures/temporal-replay/refuse-last-signal-workflow.ts), which
  this line's workflow never does.

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
bundles match their source; so do 00094c66's, c7646ed3's and (paths aside,
see above) 455ccc32's (manifest field `committedBundleDiffersFromSourceIn`,
recorded 2026-10-09).

### Upgrade procedure

An upgrade from a deployed build (the live orchestration service, the
installed launcher lineage or origin/main) starts with the "Pre-upgrade
checklist" below, which keeps that build a working rollback target.

Conservative path: rolling back stays possible until an explicit flip. The
steps apply to r4, the round-5 base and r5 integration; "the candidate" is
the one build every host is upgraded to. The round-5 base adds to r4 the
quarantine table, the quarantine commands and the `recoveryQuarantine`
section of the assignment GET, and no config key. r5 integration adds one
config key, `a2aV2.previousResultGraphKeyEnvs` (claude/fix5-key-rotation,
merge 8e965197; see "Configuration keys added in rounds 3 to 5"). It is
optional: leave it unset for the upgrade, and set it only for a key
rotation (see "Result graph key rotation (claude/fix5-key-rotation)").
Corrected 2026-10-09: this paragraph said no config key was added after r4,
which was written before key rotation was merged.

1. Before: back up the ledger database. Stop every host that shares it, or
   plan one host at a time knowing that a host whose format another host
   changed refuses to record until it restarts. On the candidate checkout run
   `bun run test:file tests/loop/temporal-bundle-replay.test.ts`. The
   current version (74 tests) is on claude/fix6-replay-coverage (c94d65a8)
   and the integration branches that merge it: c94d65a8 is r5 integration
   (9b3dca36) plus test files, fixtures, the history recorder script and
   this runbook only (`git diff --stat 9b3dca36 c94d65a8 -- loop-fork/src`
   is empty), and all 74 pass there (2026-10-09), so in-flight V2 messages
   and task graphs need no drain when upgrading to that line from 40097564,
   ef570282, 00094c66 or c7646ed3, nor do the live service's (455ccc32) V1
   messages, governess beats and task graphs. The earlier version (29 tests)
   is not in the round-5 base commit (c7646ed3) or in r4: it is on
   claude/fix5-temporal-replay (c2ea0eae) and r5 integration (merge
   9b3dca36). c2ea0eae is c7646ed3 plus test files, the history recorder
   script and this runbook only (`git diff --stat c7646ed3 c2ea0eae --
   loop-fork/src` is empty), so its run checked the round-5 base's own
   bundle: all 29 pass there (2026-10-07) and on r5 integration (2026-10-09,
   at 9b3dca36 with only test files changed). For either of those
   candidates, in-flight V2 messages and task graphs need no drain when
   upgrading from 40097564 or ef570282; to run the check on a round-5 base
   checkout, take the test, fixture and support files from c2ea0eae. r4
   (00094c66) was not checked as a candidate: its committed bundle and
   workflow port differ from c7646ed3's, and no recorded run replayed the
   histories on it (since 2026-10-09 r4's own histories replay on the
   round-5 line, which covers upgrading from r4, not to it). Do not upgrade
   to r4 with V2 executions in flight. If any test fails on the candidate,
   do not upgrade with executions in flight (see "In-flight Temporal
   executions across a bundle change"). (Corrected 2026-10-09: this step
   said all 29 pass "on the round-5 base", right about the code but not
   about where the file is.)
2. Config, on every host: if `resultArtifacts` has entries, add
   `resultGraphKeyEnv` and provide the key through the secret store.
   Recompute each entry's `graphWorkflowId` with `loop orchestration
   result-graph-id`. An entry for a binding recorded under its unkeyed v2 id
   may keep that id. Leave `workflowIdFormat` unset (legacy write).
   Optionally set `readinessOutageBoundMs` and `notEnrolledBoundMs`.
   Exception: from an r3-written database, set `workflowIdFormat`
   `"deployment"` now, or start is refused while its deployment rows are
   unsettled.
3. Start every host on the candidate checked in step 1, the same build on
   every host that shares the database. (Corrected 2026-10-09: this step
   said "on r4" whatever the candidate.)
4. Verify on each host: the legacy-format start line; `GET /healthz` reports
   `state` "ready" and `notEnrolledCount`; the authenticated `GET
   <routePath>/assignment` answers; any "will never publish" lines are
   expected and listed. In the database:
   `SELECT value, build_id FROM loop_supervisor_message_v2_schema_marker WHERE name = 'workflow-id-format.v1'`
   returns `legacy` and this build's id.
5. Flip, optional and not part of the shipping path (owner decision
   2026-10-09: legacy write is the shipping default, no flip): only after
   every host that shares the database runs the candidate (r4 or later), set
   `workflowIdFormat` `"deployment"` on every one of them and restart each.
   Verify the deployment-format start line and
   the marker value `deployment`. From then on 40097564 can record nothing
   on this database and its recovery refuses deployment-format rows.

### Rollback procedure

This subsection rolls back within the V2 line: to 40097564 (r2), ef570282
(r3) or r4. None of them is deployed, installed or on origin/main. To return
to a build that is actually deployed, see "Rollback to the deployed builds"
below.

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
- From claude/fix5-key-rotation or r5 integration to the round-5 base, r4
  or 40097564: remove
  `previousResultGraphKeyEnvs` first (an older build refuses the unknown
  field and does not start). An older build holds only the primary key, so
  every binding still listed under `underPreviousResultGraphKey` stops
  publishing there: roll back only once that list is empty (the retirement
  check below). The added column, trigger and lost-reservation table stay;
  the older build ignores them, but the trigger still refuses its overwrite
  of a binding recorded under a key. That includes 40097564's re-bind of a
  keyed binding to its unkeyed v2 graph, which the rollback limit above
  allows on r4 and the round-5 base (ledger test "rollback limit: the
  base-era ledger does not publish a result this build bound to its keyed
  graph, and the database refuses its re-bind of that message to its
  unkeyed graph").

### Rollback to the deployed builds

Written 2026-10-07 on claude/fix5-rollback-to-deployed (from the round-5
base, c7646ed3). Tests: `tests/loop/orchestration-rollback-to-deployed.test.ts`.

#### What is deployed (read-only checks, 2026-10-07)

- The orchestration service is launchd job `com.harness.loop-orchestration`.
  It runs `/Users/amgad/.loop/bin/loop-orchestration-serve`, which sources
  the 0600 `~/.config/loop/orchestration.env` and execs
  `${LOOP_BIN:-$HOME/.local/bin/loop} orchestration serve ~/.loop/orchestration/config.json`.
  The running process (pid 1400, started 2026-10-05 14:41 PDT) executes
  `/Users/amgad/.loop/bin/candidates/loop-ed33f43f`: its text inode is that
  file's, and the file's sha256 is
  `ed33f43f30e0b909ac30668e1084bf8d20d427beb44010acb6d565df3277c4e2`. The
  service's activation packet (§2) records it as built from 455ccc32
  (claude/orchestration-session-comms). 455ccc32 is not an ancestor of the
  V2 line: the two share 4439b2e7 as merge base.
- The installed launcher, `~/.local/bin/loop`, is sha256 `ba3671b6…`
  (installed 2026-10-04 21:42 PDT), recorded as the installed candidate in
  `specs/governess-qwen-location-v1/status.md` at ea968d82. It is not
  678e2fde: that binary (built from 4439b2e7) is retained as
  `~/.loop/release-backups/loop.pre-no-session-pressure.678e2fde.20261004T195614Z`
  (hash checked). `~/.loop/binary-of-record.sha256` holds `9dac1029…`, which
  is neither. 4439b2e7 and ea968d82 hold the same blob for the orchestration
  server, every workflow file and the generated workflow bundle (cebd34d4),
  so for orchestration they are one build. The service does not run this
  binary unless `LOOP_BIN` is unset.
- origin/main is dde60215: `git ls-remote origin main`, where `origin` is
  the Forgejo remote `http://192.168.1.18:3100/amgad/agents-collab.git`.
  The `github` remote (`https://github.com/amgadabdelhafez/agents-collab.git`)
  has main at 31ff22a7, which diverged from dde60215 (merge base 0f69b9a9)
  and has no `loop-orchestration-server.ts` at all, so it is no
  orchestration build and no rollback target. In a checkout where `origin`
  names GitHub, "origin/main" below still means the Forgejo main, dde60215.
- No retained binary is recorded as built from dde60215: no install record
  or backup name names it. Comparing hashes cannot settle it either way,
  since no reference sha256 of a dde60215 build is recorded and bun-compiled
  binaries are not reproducible. Rebuild from the commit if one is needed.
- The activation packet's pre-activation config,
  `~/.loop/orchestration/config.json.bak-20260920T004032Z` (sha256
  `98bab79bf70c…`, mtime 2026-09-05), is still there; it is the config the
  packet's rollback restores (§8, §8a, §11). Its key structure (values not
  read): the base keys, no `deadlines`, no `a2aV2`, no `wake`; 12 grants;
  three supervisors, `supervisor:harness`, `supervisor:harvto` and
  `supervisor:ai-cur`, each exactly {manifestPath, principal, supervisorId,
  tokenEnv}, with no mailbox. All three manifest paths exist; each of the
  three `tokenEnv` names has exactly one line in the env file (lines
  counted, never printed); address, buildId, hostname, identity, namespace,
  port, schema, stateDir and taskQueue are equal to the live config's. A
  second file, `config.json.bak-20260920T022206Z`, has the live config's
  sha256 (`c0c925483a37…`), so it is a copy of today's mailbox config, not a
  pre-activation one.
- None of 455ccc32, 4439b2e7, ea968d82 or dde60215 holds any V2 code: no
  `a2aV2`, no `supervisor-message.v2` workflow definition, no
  `loop_supervisor_message_v2` table (`git grep`; the one textual match is a
  replay fixture's worker label, `supervisor-message.v2-worker`).
  Byte probes of `loop-ed33f43f` and `~/.local/bin/loop` find no `a2aV2` or
  `supervisor-message.v2`, with `loop-orchestration-health.v1` as control.
- The live config's key structure (values not read): top level
  `deadlines` and the base keys; five supervisors, each exactly {mailbox,
  principal, supervisorId, tokenEnv}, none with `manifestPath`; no `a2aV2`,
  no `wake`.

#### What each deployed build does with V2 state

(a) A config this line wrote. Every deployed parser checks keys exactly and
refuses to start, with no other effect. Tested against each build's own
vendored parser:

| Build | Refuses at top level ("orchestration config has invalid fields") | Refuses per supervisor ("orchestration supervisor has invalid fields") | Accepts |
| --- | --- | --- | --- |
| 455ccc32 (live service) | `a2aV2`, `wake` | `seat`, `wakeSession` | `deadlines`, `mailbox`, mailbox-only supervisors |
| 4439b2e7 = ea968d82, dde60215 | `a2aV2`, `deadlines`, `wake` | `mailbox`, `seat`, `wakeSession`, and any supervisor without `manifestPath` | base keys only |

So 4439b2e7, ea968d82 and dde60215 refuse the live service's config as it
is today, V2 or not (test "the launcher lineage and origin/main cannot run
the live service's config at all"). They do accept the live service's
pre-activation config, the manifest-only file the activation packet's
rollback restores, and read it as 455ccc32 and this build do (test "the
activation packet's pre-activation config shape starts on every deployed
build, which read it as this build does"). The packet's rollback has two
halves (§8, §8a and §11): delete the `LOOP_BIN` line, so the wrapper falls
back to `~/.local/bin/loop` (floor 678e2fde), and restore
`config.json.bak-20260920T004032Z`, then kickstart. Done whole, it still
works, as a degraded rollback of the live service: see Rollback B1. Done
half, deleting the `LOOP_BIN` line while the mailbox config stays, it does
not: the fallback binary refuses that config and launchd's KeepAlive
(ThrottleInterval 10) restarts it every 10 seconds.

(b) The V2 PostgreSQL database. No deployed build can open it. The
orchestration server's import closure at each of the four commits contains
no database client (computed over relative imports; only the retired DBOS
replay files mention PostgreSQL, outside the closure, and they start their
own container). `databaseUrlEnv` lives only in `a2aV2`, which every deployed
parser refuses. So tables, the format marker, quarantine rows and result
bindings stay exactly as the V2 build left them, and the variables named by
`databaseUrlEnv` and `resultGraphKeyEnv` are ignored. Not exercised by a test,
since there is no code to exercise.

(c) Temporal executions this line left on the same task queue. All builds
here register the generic workflow function `temporalWorkflow` and dispatch
on a `workflowType` field inside the input. Tested on a real Temporal dev
server with this build's committed bundle against each deployed build's
workflow code, run twice: once as its commit's own committed generated
bundle, read from git by pinned blob id (cebd34d4 at 4439b2e7 and ea968d82,
which 455ccc32 also commits; 17cd45cd at dde60215), which is what a binary
built from that commit embeds; once rebuilt from its dispatcher, vendored
unmodified. Every worker is composed as the deployed servers compose
theirs: `buildId` without versioning, `debugMode` on (`workflowExecution:
"in-process"`).

- `supervisor-message.v2` executions, under legacy and deployment ids, are
  held, not failed. A deployed worker that gets one of their workflow tasks
  fails the task with `unknown workflow type supervisor-message.v2`, and a
  query fails with the same message. The execution stays RUNNING. The
  TypeScript SDK fails only the task because the dispatcher throws a plain
  `Error` subclass and no worker sets `workflowFailureErrorTypes`; with
  `{"*": ["Error"]}` set, the test fails.
- Expect noise for the whole rollback. History records one
  WorkflowTaskFailed per held execution, but Temporal keeps retrying the
  workflow task (the test checks that the pending task's attempt passes 1),
  and each attempt logs a "workflow task failed" warning on the server and
  the worker. Observed once on 2026-10-07, not asserted: with retries under
  way, a query on a held execution sometimes waited 30 s and failed with
  "Failed to query Workflow", and sometimes failed
  at once; a reviewer saw about 10 s. A monitor or operator that queries
  these executions sees errors or stalls, not answers.
- Rolled forward, this build replays the history, applies any command that
  arrived meanwhile (the test's cancel is recorded as `canceled`), and no
  execution failed.
- `task-graph.v1` (result graphs under `supervisor-result-graph:v3:` ids
  included) and `supervisor-message.v1` run on both builds: the deployed
  worker answers the same inspection this build did, applies a command, and
  this build replays that history after rolling forward.
- In depth, since 2026-10-09 (temporal-bundle-replay, handoffs
  "deployed-455ccc32 left in flight continue on current" and "current left
  in flight continue on deployed-455ccc32", and the recorded answers of the
  455ccc32 fixtures): nine V1 message states (escalation and dead letter by
  `clock_tick` and a cancel included), two governess beat runs and five task
  graphs, left in flight by either build, answer every query on the other
  exactly as before and finish the same way. A V2 execution is still held,
  as above.
- dde60215 has no `governess-beat.v1`. A beat execution on the same queue
  would be held by the same mechanism (not separately tested). The live
  service (455ccc32) commits the launcher lineage's bundle blob, so the
  launcher lineage's run stands for it.

Only the deployed builds' config parsers and workflow dispatchers ran. Their
HTTP routes, bridge, mailbox and deadline code are stated below from code
reading. The committed-bundle runs need a full clone: they read
4439b2e7, ea968d82 and dde60215 from git, all ancestors of this line
(test "each deployed commit commits the pinned generated workflow bundle
blob"). 455ccc32 is on no remote, so its bundle blob (cebd34d4, checked
with `git rev-parse` on 2026-10-07) is not pinned by a test.

#### Rollback A: the live service to loop-ed33f43f (455ccc32)

This is the full-function rollback for the live service: it keeps mailbox
delivery and deadlines. The activation packet's own rollback to the
launcher lineage remains available as a degraded alternative (Rollback B1).

1. Check the binary: `shasum -a 256 /Users/amgad/.loop/bin/candidates/loop-ed33f43f`
   prints `ed33f43f30e0b909ac30668e1084bf8d20d427beb44010acb6d565df3277c4e2`.
2. Config: restore the pre-upgrade copy from the checklist:
   `cp -p ~/.loop/orchestration/config.json.pre-v2-<UTC> ~/.loop/orchestration/config.json`.
   Without a copy, edit the V2 config: delete top-level `a2aV2` and `wake`;
   delete `seat` and `wakeSession` from every supervisor. Keep `deadlines`,
   every `mailbox` and every mailbox-only supervisor. A supervisor with a
   `manifestPath` added for the V2 recipient may stay. Each deletion is
   needed and none more (tests "each rollback step is needed by 455ccc32 …"
   and "455ccc32 … refuses to start on each key this line added that it does
   not know, and only those"); 455ccc32 and this build read the result the
   same way (test "455ccc32 … starts on the rolled-back config, which this
   build reads the same way").
3. Binary: rewrite, do not delete, the `LOOP_BIN` line, without printing the
   file (it holds tokens):
   `sed -i '' 's#^LOOP_BIN=.*#LOOP_BIN=/Users/amgad/.loop/bin/candidates/loop-ed33f43f#' ~/.config/loop/orchestration.env`,
   then `grep -c '^LOOP_BIN=/Users/amgad/.loop/bin/candidates/loop-ed33f43f$' ~/.config/loop/orchestration.env`
   prints 1. The V2 variables (database URL, result graph key) may stay in
   that file for a later roll forward; 455ccc32 reads only each supervisor's
   `tokenEnv`.
4. Restart: `launchctl kickstart -k gui/$(id -u)/com.harness.loop-orchestration`.
   It ends the V2 process before 455ccc32 starts, so the two never poll the
   task queue together. Steps 2 and 3 come first: KeepAlive restarts the job
   at once.
5. Verify: `pgrep -fl 'orchestration serve'` names `loop-ed33f43f`, and
   `lsof -p <pid>` shows that file's inode as text; `GET /healthz` answers
   `{"schema":"loop-orchestration-health.v1","state":"ready"}`, with no
   counts (a monitor that reads `notEnrolledCount` must tolerate its
   absence); `~/.loop/logs/loop-orchestration.err` has no "has invalid
   fields".
6. Database: leave it. Do not drop, migrate or edit it. A decommissioned V2
   deployment's rows are not closed by hand (owner decision 2026-10-09: no
   hand-recorded terminal outcomes); no override exists.
7. V2 executions: leave them running. Do not terminate them: an execution the
   engine closed while its message was open is recorded `terminated` at the
   next V2 sweep (test "a sweep records terminated for an execution the
   engine closed while its message was open",
   supervisor-message-v2-temporal-retention.test.ts), so that message would
   never be delivered after a roll forward. Do not signal or query them
   while 455ccc32 runs: each attempt fails a workflow task or a query, and
   a query may stall before it fails. Their workflow task retries and
   "workflow task failed" warnings continue for as long as 455ccc32 runs
   (see (c)); that noise is expected, not a new fault.
   V1 messages and task graphs, result graphs included, keep running.
8. A2A V2 senders: 455ccc32 mounts no route at `a2aV2.routePath`. A request
   it does not authenticate answers 401 `{"error":{"code":"unauthorized"}}`;
   one it does answers 404 `not-found` (400 `invalid-request` for a body
   that is not JSON). Nothing is recorded, so a sender must retry after the
   roll forward with the same dedupe key. By code reading
   (supervisor-orchestration-http.ts:357-410 at 4439b2e7, the same blob at
   455ccc32).
9. What changes while rolled back, by code reading: no waking (`wake`,
   `wakeSession` are gone); a supervisor whose `seat` named a pane other than
   its run's `primaryAgent` is delivered to `primaryAgent`; /healthz carries
   no counts; V1 delivery uses 455ccc32's bridge port, which lacks this line's
   per-message bridge dedupe (`supervisor-delivery:<workflowId>`), so a V1
   delivery in flight at the switch may reach the pane twice (untested).

Roll forward again: put the V2 config back, point `LOOP_BIN` at the V2
candidate, and kickstart. Held V2 executions resume (tested). Before the
kickstart, check `bridge-dedupe-claims/` for stale claim files (Pre-upgrade
checklist, item 4): a V2 process that step 4 ended inside an enqueue leaves
one and 455ccc32 never removes it. A V2 build without claude/fix6-hygiene
(r5 integration and earlier) would answer `deferred` to that message for as
long as it stays; one with it reclaims the claim on the next enqueue once
its owner pid is not running or was reused (see item 4). How the V2
runtime treats claim,
retry and escalation deadlines that passed during the rollback is
unverified.

#### Rollback B: to the launcher lineage or origin/main

Both cases end on a build without mailboxes, deadlines or V2 code: 678e2fde
(4439b2e7), ba3671b6 (ea968d82) or a dde60215 build.

##### B1: the live service, by the activation packet's own rollback (degraded)

The packet's rollback (§8, §8a, §11), done whole: the launcher lineage
binary with the pre-activation config. It starts (test "the activation
packet's pre-activation config shape starts on every deployed build, which
read it as this build does"), and the service ran on this config until
2026-09-20, under an older image. Use it only when Rollback A is unavailable, for example when
`loop-ed33f43f` is lost or is itself the suspect: it gives up mailbox
delivery and deadlines.

1. Keep what a later step needs: copy the V2 config for the roll forward,
   `cp -p ~/.loop/orchestration/config.json ~/.loop/orchestration/config.json.v2-<UTC>`,
   and keep the checklist's pre-V2 copy (`config.json.pre-v2-<UTC>`) for a
   later move to Rollback A.
2. Check the pre-activation config is still the one described above:
   `shasum -a 256 ~/.loop/orchestration/config.json.bak-20260920T004032Z`
   starts with `98bab79bf70c`; its three manifest paths exist; each of its
   three `tokenEnv` names has one line in the env file
   (`grep -c '^<NAME>=' ~/.config/loop/orchestration.env`, which prints a
   count, not the value). Every deployed build refuses to start when a
   configured `tokenEnv` is unset ("missing orchestration token
   environment", vendored loop-orchestration-server.ts at each commit).
3. Binary. The packet deletes the `LOOP_BIN` line, so the wrapper runs
   `~/.local/bin/loop`. That path is shared with every other project and
   changes on any install: on 2026-10-07 it is ba3671b6
   (`ba3671b6a21b21159f5a639103c504a29251385eedcfac8b9932210666abf600`,
   ea968d82). Pin the packet's floor explicitly instead (owner decision
   2026-10-09), so the rollback does not depend on what was installed last:
   `sed -i '' 's#^LOOP_BIN=.*#LOOP_BIN=/Users/amgad/.loop/release-backups/loop.pre-no-session-pressure.678e2fde.20261004T195614Z#' ~/.config/loop/orchestration.env`,
   after `shasum -a 256` of that file prints
   `678e2fde4101ab93e50cb596adeedc4ab97460676e0a0e2a13f7fc8c5adb738a`.
   Deleting the line, as the packet says, is equivalent only while
   `~/.local/bin/loop` hashes as ba3671b6 or 678e2fde.
4. Config: `cp -p ~/.loop/orchestration/config.json.bak-20260920T004032Z ~/.loop/orchestration/config.json`.
   Steps 3 and 4 both come before step 5. Either one alone leaves a pair
   that refuses to start: the launcher lineage refuses the mailbox config,
   and KeepAlive restarts the refusing process every 10 seconds.
5. Restart: `launchctl kickstart -k gui/$(id -u)/com.harness.loop-orchestration`.
6. Verify: `pgrep -fl 'orchestration serve'` and `lsof -p <pid>` name the
   pinned file as text; `GET /healthz` answers
   `{"schema":"loop-orchestration-health.v1","state":"ready"}`;
   `~/.loop/logs/loop-orchestration.err` has neither "has invalid fields"
   nor "missing orchestration token environment".
7. What is lost while rolled back, by code reading of the vendored
   launcher-lineage server (it has no mailbox, deadline or mailbox-ack code
   at all) unless a test is named:
   - Mailbox delivery. `supervisor:harness-desktop` and
     `supervisor:portfolio-coordinator` are not in the pre-activation
     config, so their tokens no longer authenticate (401), and the 12 grants
     predate them. An open V1 message addressed to either has no route: it
     makes no progress unless a client ticks it, and each ticked attempt
     fails transiently until `maxDeliveryAttempts`, when it is
     dead-lettered (as in B2, step 2).
   - Deadlines. No deadline driver runs, so claim, retry and escalation
     deadlines apply only when a client ticks a message.
   - Mailbox acknowledgments. Nothing reads the mailboxes, so an ack a
     recipient writes there is not reported to its workflow until a build
     with mailbox consumption runs again. Mailbox files and cursors are left
     as they are: this build has no code that opens them.
   - The three retired identities get their `manifestPath` back, which the
     packet's §4.1 removed so that they "cannot route however their dead
     runs change state". That protection is gone while rolled back.
     Owner decision 2026-10-09: strip the retired identities'
     `manifestPath` from a copy of the pre-activation config before B1.
     Not yet a step here, because as worded it cannot start: the three
     retired identities are the pre-activation config's only supervisors,
     and every B1 build requires an absolute `manifestPath` on every
     supervisor and at least one supervisor (vendored
     loop-orchestration-server.ts at 4439b2e7 and dde60215,
     `parseLoopOrchestrationConfig`; tests "each rollback step is needed by
     4439b2e7 = ea968d82 …" and "… by dde60215 …", whose step removing
     supervisors without `manifestPath` is needed because those builds
     refuse them). A stripped copy is refused at start, and KeepAlive
     restarts it every 10 seconds. How to honour the decision is an open
     question for the owner (decisions.md, 2026-10-09 entry).
   - Everything in Rollback A, steps 6 to 9: the database is left as is,
     V2 executions are held (with the retry noise in (c)), A2A V2 senders
     get 401 or 404 and must retry after the roll forward, no waking, no
     counts on /healthz.
8. Leave it: roll forward to V2 with the `config.json.v2-<UTC>` copy and
   `LOOP_BIN` on the V2 candidate, or move to Rollback A with the
   `config.json.pre-v2-<UTC>` copy and `LOOP_BIN` on `loop-ed33f43f`. Each
   is a config copy, a `LOOP_BIN` rewrite, then a kickstart. Messages
   dead-lettered while rolled back stay dead-lettered.

##### B2: another host on the launcher lineage or origin/main

For a host whose pre-V2 build was one of those builds, and whose config
therefore never had mailboxes or `deadlines`. No such orchestration host is
known on 2026-10-07.

1. Binary: 678e2fde is retained (path above); ba3671b6 is the installed
   `~/.local/bin/loop`, and becomes a rollback target only if a copy is kept
   before it is replaced; a dde60215 binary must be rebuilt from that commit.
2. Config: restore the pre-upgrade copy. Without one, delete top-level
   `a2aV2`, `deadlines` and `wake`; delete `mailbox`, `seat` and
   `wakeSession` from every supervisor; delete every supervisor without
   `manifestPath`. Each step is needed (tests "each rollback step is needed by
   4439b2e7 = ea968d82 …" and "… by dde60215 …"). Also delete the grants that
   name a deleted supervisor: the parser does not check them, so this is
   hygiene, not a start condition. A V1 message to a deleted mailbox-only
   recipient has no route on that build: each delivery attempt fails
   transiently, and after `maxDeliveryAttempts` the message is dead-lettered
   (by code reading of its bridge port and supervisor-message-workflow.ts).
   These builds have no deadline driver, so attempts happen only when a
   client ticks the message.
3. Restart with the build's own service mechanism; the same database,
   Temporal and A2A sender facts as in Rollback A, steps 6 to 9, apply.

#### Pre-upgrade checklist

Before the V2 line replaces the live service:

1. Identify what runs, by inode and hash, not by name: `pgrep -fl
   'orchestration serve'`, `lsof -p <pid>` (text entry), `shasum -a 256 <that
   path>`. Map the hash to its source through its install record. On
   2026-10-07 that is `loop-ed33f43f` from 455ccc32. Keep that file; do not
   delete `~/.loop/bin/candidates/`. Keep the degraded fallback too
   (Rollback B1): the retained 678e2fde binary in `~/.loop/release-backups`
   and `~/.loop/orchestration/config.json.bak-20260920T004032Z`, each
   checked against the sha256 given above.
2. Copy the config byte for byte, and record the copy's sha256:
   `cp -p ~/.loop/orchestration/config.json ~/.loop/orchestration/config.json.pre-v2-<UTC>`.
   This copy, not an edited V2 config, is the Rollback A config.
3. Check that the pin exists without printing the env file:
   `grep -c '^LOOP_BIN=' ~/.config/loop/orchestration.env` prints 1. The
   upgrade rewrites that line; a rollback rewrites it back.
4. Back up the config's `stateDir` (`threads.jsonl`, `governance.jsonl`)
   and each supervisor's mailbox file and cursor. The V2 line reads and
   writes them with the same code as 455ccc32: supervisor-thread-store.ts,
   supervisor-message-governance.ts, supervisor-mailbox-delivery.ts,
   supervisor-mailbox-cursor.ts, supervisor-bridge-consumption.ts and
   supervisor-deadline-driver.ts have the same blob at both, and
   supervisor-mailbox-consumption.ts differs only in comment text
   (`git diff 455ccc32 <V2 head>`: +8/-2, all inside one doc comment).
   Two files that touch the same state do differ (checked 2026-10-09,
   455ccc32 against r5 integration 9b3dca36; added because this item used
   to list only the files that match):
   - bridge-store.ts (blob 1aff02cb at 455ccc32, 68848f7d at 9b3dca36),
     with bridge-supervisor-message-delivery.ts, bridge-runtime.ts and
     bridge.ts. These write each run's `bridge.jsonl`, the queue a V1
     message to a supervisor with a `manifestPath` goes through. The
     record format is unchanged; the enqueue is not. The V2 line keys a
     supervisor delivery `supervisor-delivery:<workflowId>` and deduplicates
     it against the run's whole bridge history, not only pending messages,
     and reuses an earlier enqueue of the same message instead of adding
     another; 455ccc32 keys each attempt by its idempotency key and
     deduplicates pending messages only. Every keyed enqueue on the V2 line
     holds a claim file `<runDir>/bridge-dedupe-claims/<sha256>.lock`
     (0600, created with exclusive create, holding `<pid>:<uuid>`) for the
     length of the enqueue, removes it when the enqueue returns or throws,
     and answers `deferred` while the file exists; 455ccc32 has no claim
     files and ignores the directory. Up to r5 integration (9b3dca36)
     nothing recovers a stale claim: no code checks the pid or the
     file's age, so a process that dies mid-enqueue (a crash, `kill -9`,
     a restart that lands inside the enqueue) leaves the file behind, and
     every later enqueue of that
     message, same source, target and key, answers `deferred` until
     someone removes it. Supervisor delivery treats `deferred` as a
     transient failure, so that message is retried but not queued while
     the file exists (bridge-store.ts `acquireBridgeDedupeClaim` and
     `enqueueBridgeMessage`, bridge-supervisor-message-delivery.ts at
     9b3dca36; reproduced 2026-10-09 in a scratch run directory: a claim
     acquired and never released, three enqueues under its key all
     `deferred`, another key `queued`). Pre-existing on the V2 line up to
     r5 integration. Since claude/fix6-hygiene (6f560720, merged on r6
     integration, claude/fix-integration-r6-2026-10-09), an enqueue that
     finds a claim reclaims it only when its owner pid is not running, or
     is running but started after the claim was written (a reused pid); a
     claim whose owner is alive with an unknown or not later start time,
     or whose owner token cannot be parsed, is never reclaimed and still
     answers `deferred` (bridge-store.ts, pid-ownership.ts
     `pidCanStillOwnRun`; tests/loop/bridge-dedupe-claim-reclaim.test.ts).
     Earlier V2 builds never reclaim. So before an upgrade, after it, and
     before and after any rollback or roll forward, list
     `bridge-dedupe-claims/` in the run directory of every supervisor
     with a `manifestPath`, and of any
     run whose own processes run a V2-line build (governess controls and
     the bridge tool's `dedupe_key` take claims too). With every process
     that writes that run's bridge stopped, any file there is stale. While
     they run, a file whose pid (the text before the first `:`) is not a
     running process (`ps -p <pid>`) is stale; a reused pid can make a
     stale file look live, so stop the writers when in doubt. Remove only
     stale files, and record what you removed. By code reading, the live
     config has no `manifestPath` supervisor, so this path is idle there
     until an `a2aV2` recipient is added (item 6). Back up, with the state
     above, the run directory (`bridge.jsonl`) of any supervisor that has a
     `manifestPath`. The reverse direction is Rollback A, step 9.
   - mailbox-command.ts (blob 98a01a2d at 455ccc32, d6193278 at 9b3dca36),
     the `loop mailbox` command recipients run against the mailbox files.
     The V2 line adds `loop mailbox send`, a peer note between sessions:
     it appends an envelope with workflow id `peer-message:<message-id>`
     and idempotency key `<sender>:<message-id>:peer:1` to the recipient's
     mailbox file, and refuses a different body under the same message id.
     455ccc32's `loop mailbox` has no `send` and refuses it as an unknown
     action. The consumption reconciler (same code at both, see above)
     counts an acknowledged envelope whose workflow id is not
     `supervisor-message:<sha256>` as unmatched
     (supervisor-mailbox-consumption.ts, `WORKFLOW_ID_RE`), so on either
     build a peer note is read and acknowledged like other mail and
     advances no workflow. `status`, `receive` and `ack` are unchanged.
     The mailbox backup above covers peer notes too.
5. Temporal: record the config's namespace and task queue. `temporal
   task-queue describe --namespace <ns> --task-queue <queue>` lists only the
   service's own poller. No other build may poll that queue while the V2
   line runs: a deployed worker fails every V2 workflow task and query it
   receives (test above). Record the open executions by type for comparison
   afterwards. The service's open V1 messages, governess beats and task
   graphs need no drain: the V2 line continues them as 455ccc32 would
   (temporal-bundle-replay, 2026-10-09, see "In-flight Temporal executions
   across a bundle change").
6. Config for the V2 line: the live config needs no change to run on it
   (test "the live service's config shape needs no change to upgrade, and
   this build reads it as the service does"). Adding `a2aV2` needs more than
   the `a2aV2` object: its `recipient` must be a supervisor with a
   `manifestPath`, a Loop pane binding, and the live config has none (test
   "a2aV2 on the live service's config shape is refused: its recipient must
   be a Loop pane binding"). Its `principal` must be a configured
   supervisor's. Leave `workflowIdFormat` unset.
7. Database and secrets: a database for the ledger, with a backup plan; its
   URL and, if `resultArtifacts` is used, the result graph key in the 0600
   env file through the secret procedure, never in the config or a command
   line.
8. Before any later step that blocks rollback (the format flip, which the
   owner decided on 2026-10-09 not to take: legacy write is the shipping
   default), take this checklist again: after the flip, a return to
   legacy ids is refused while deployment-format intents are unsettled, but
   a return to 455ccc32 is not affected, since 455ccc32 never opens the
   database.

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

Procedure, if a rotation cannot wait for claude/fix5-key-rotation:

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

### Result graph key rotation (claude/fix5-key-rotation)

Not on r4 or the round-5 base; on r5 integration (merge 8e965197). Verified
on 2026-10-07 by tests/loop/supervisor-a2a-result-key-rotation.test.ts (18
tests; 20 with the two settled-check tests claude/fix6-runbook-tests adds)
on real PostgreSQL 17, and loop-orchestration-server-postgres "the orchestration
server holds its configured previous result graph keys" with Temporal.

What a host does with its keys:

- New bindings and result graphs are derived under the primary key
  (`resultGraphKeyEnv`) only. Nothing new is bound under a previous key: a
  bind naming a graph derived under one is refused, 409
  `{"code": "result-graph-under-previous-key"}` (a2a-supervisor-assignment-http.ts:71-77),
  except an exact retry of the binding already recorded while it still holds
  its graph task (supervisor-message-v2-delivery-ledger.ts:1371-1418).
- A binding derived under a previous key still publishes. A binding derived
  under a key the host does not hold is refused on publish with an error
  naming the key's fingerprint, and reported (`unknown-result-graph-key`).
- Each binding records the fingerprint of its key
  (`rgk:` + 16 hex digits, not reversible) and the deployment (task queue)
  that recorded it, in the additive column `bound_by_deployment`
  (supervisor-message-v2-delivery-ledger.ts:1179-1183).
- `loop orchestration result-graph-key-fingerprints <config-path>` prints
  `<ENV> <primary|previous> <fingerprint>` per configured key, never a key
  (loop-orchestration-server.ts:1650-1675). Use it to match a fingerprint in
  a log line or listing to a variable.

Whose bindings a host classifies (round-4 major 1). Keys belong to a
deployment, so a host classifies, lists and reports only its own
deployment's bindings, never those of another deployment sharing the ledger
database (supervisor-message-v2-delivery-ledger.ts:626-661):

- a binding recorded by this build belongs to the deployment that recorded
  it;
- a binding an older build recorded names no deployment and belongs to its
  message's owner: a deployment-format message (id
  `supervisor-message-workflow:v2:deployment:...`) to the deployment its
  start intent names; a legacy message to every deployment, as for
  recovery;
- the start report and the authenticated GET are further limited to the
  host's route tenant (supervisor-a2a-v2-service.ts:676-700). The start
  report of body-chosen and lost-reservation bindings is now limited to the
  route tenant too; before, a host reported every tenant's.

Limit: a legacy binding recorded by an older build, of the host's own
tenant, cannot be told apart from one under a key this deployment removed,
so it is reported by every deployment that shares the database and serves
that tenant (test "with legacy workflow ids, whose messages name no
deployment, ..."). Bindings recorded by this build are not affected.

When a binding settles (round-4 major 2). A binding needs no key any more
once its result was published (its A2A task holds the message's
`accepted:<messageWorkflowId>` artifact) or its A2A task ended without a
result (failed, canceled or rejected), since publication is then refused
forever. A missing task, a COMPLETED task that does not hold the message's
accepted artifact, or a task-store read that fails, counts as not settled,
so nothing is hidden (supervisor-a2a-v2-service.ts:644-673;
supervisor-message-v2-delivery-ledger.ts:663-702; owner decision
2026-10-09). Tests: "a host holding no result graph key names the key …"
and "with legacy workflow ids, …" (a missing task), and, added 2026-10-09
on claude/fix6-runbook-tests, "a COMPLETED A2A task without the message's
accepted artifact does not settle that message's binding: …" and "a settled
check that cannot read the A2A task store keeps the binding listed and
reported: …". Settled bindings are left
out of `underPreviousResultGraphKey`, and out of the `unknown-result-graph-key`
start lines and listing once their key is removed. A settled binding stays
recorded under its key; after that key is removed, re-publishing its
already published result is refused with the unknown-key error.

Settling is final, so a deployment checks a binding against its A2A task
store until it settles and never again (claude/fix6-hygiene). Each settled
binding is recorded per deployment in the additive table
`loop_supervisor_message_v2_settled_result_binding` (workflow id, A2A task
id, deployment), and the start report and the GET read only bindings not
recorded there. Before, every start and every GET re-checked every binding
under a non-primary key, and each rotation added more. A missing task, a
task without its accepted-result artifact and a failing read are never
recorded, so they are checked again each time. An older build never reads
the table; deleting its rows only makes the host check those bindings again
(supervisor-a2a-result-key-rotation, 20 tests on claude/fix6-hygiene and
22 on r6 integration with claude/fix6-runbook-tests' two: "a settled binding is
remembered durably: ..." and "a settled binding is remembered per
deployment: ...").

Authenticated `GET <routePath>/assignment` adds
`"underPreviousResultGraphKey": [{"a2aTaskId", "graphTaskId", "graphWorkflowId", "keyFingerprint", "messageWorkflowId"}]`:
this route tenant's unsettled bindings under a previous key of this
deployment. /healthz carries no binding, key or fingerprint.

Do not rename the task queue during a key rotation. The host's task queue
(`taskQueue`, the orchestration config key) is its deployment: the ledger
classifies, lists and reports only the bindings whose `bound_by_deployment`
is that name (or whose deployment-format message its start intent assigns
to it), and the settled record above is kept per deployment. A host
restarted under a new task queue name owns none of the bindings recorded
under the old name, so:

- `underPreviousResultGraphKey` and the `unknown-result-graph-key` start
  lines stop naming them, and the retirement check below passes while
  bindings under the previous key are still waiting to publish. Removing
  that key then strands them: they can never publish;
- deployment-format message ids are minted for the deployment, so messages
  started under the old name are another deployment's messages to the
  renamed host;
- every binding is checked against the A2A task store again, once, under
  the new name.

Keep the task queue name unchanged from step 1 of the rotation until the
retirement check has passed and the previous key's variable is removed. If
a rename is needed, do it on its own, outside any rotation, after every
previous key has been retired and every binding the host still lists has
settled.

Rotation procedure:

1. Before rotating, bind every result graph already started under the
   current key. A graph started but not bound when its key becomes a
   previous key can never be bound; it must be started again under the new
   key. Each start reports such a graph that `resultArtifacts` lists:
   `A2A V2 result graph cannot be bound (started-under-previous-result-graph-key): ...`.
2. Put the new key in the secret store under a new variable name. Set
   `resultGraphKeyEnv` to it and add the old variable's name to
   `previousResultGraphKeyEnvs`, on every host of the deployment. Keep every
   existing `resultArtifacts` `graphWorkflowId` as it is; compute ids with
   `loop orchestration result-graph-id` only for messages not bound yet.
3. Restart each host. Check with `result-graph-key-fingerprints` that the
   old fingerprint is `previous` and the new one `primary`.

Retirement check, before removing a previous key's variable, on each route
tenant of the deployment:

1. `loop orchestration result-graph-key-fingerprints <config-path>`: note
   the fingerprint of the variable to remove.
2. Authenticated `GET <routePath>/assignment`: no entry of
   `underPreviousResultGraphKey` has that `keyFingerprint`. Each remaining
   entry is a binding whose result has not been published yet; wait for it
   to publish, or for its A2A task to end, and check again.
3. The latest start log has no `started-under-previous-result-graph-key`
   line naming that fingerprint.

Then remove the variable from `previousResultGraphKeyEnvs` (and the secret
store), restart, and confirm the start log has no `unknown-result-graph-key`
line naming that fingerprint (test "a previous key is no longer needed once
every binding under it has settled: ...").

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

Rollback to the deployed builds, 2026-10-07 on claude/fix5-rollback-to-deployed
with a real local Temporal dev server: orchestration-rollback-to-deployed 20
tests, all pass. The vendored fixtures are `tests/fixtures/deployed-455ccc32`,
`deployed-4439b2e7` and `deployed-dde60215`, each file pinned to its blob id.
Mutations, each run and reverted: the deployed worker configured with
`workflowFailureErrorTypes: {"*": ["Error"]}` (2 fail); the deployed phase
run on this build's bundle instead of the vendored one (2 fail); a newline
appended to a vendored workflow file (its blob test fails); `wake` dropped
from the
launcher-lineage rollback steps (6 fail); `wake` dropped from the live
service's rollback steps (3 fail); `deadlines` added to them (2 fail).

After review, 2026-10-07: 25 tests, all pass. Added: the pre-activation
config shape test, the bundle pin and decoder tests, and the Temporal test
run once more per deployed build on its committed generated bundle;
workers now carry `buildId` and `debugMode`, and the Temporal test checks
that held executions keep retrying. Mutations, each run and reverted
byte for byte: `deadlines` added to the pre-activation shape (its test
fails); the vendored dde60215 parser refusing `tokenEnv` (its test fails);
the bundle decoder dropping its last chunk (3 fail: the decoder test and
both committed-bundle Temporal runs); the launcher lineage pinned to
dde60215's bundle blob (the pin test fails); `workflowFailureErrorTypes:
{"*": ["Error"]}` on the deployed worker (all 4 Temporal runs fail).

2026-10-07 on claude/fix5-temporal-replay (round-5 base plus the replay
tests), with a task-owned Temporal dev server: temporal-bundle-replay 29 tests,
all pass (2 fixture checks, 22 history replays, 2 replay controls, 3 live
handoffs).

r5 integration, 2026-10-09, on claude/fix6-runbook-tests (9b3dca36 plus two
tests in supervisor-a2a-result-key-rotation and these docs; no source
change), each file run on its own (`bun run test:file`) with task-owned
PostgreSQL and the local Temporal dev server: orchestration-command 8,
supervisor-orchestration-http 10, a2a-supervisor-assignment-http 9,
loop-orchestration-server 37, bridge-result-reply-dedupe 16,
supervisor-message-v2-runtime 32, supervisor-message-v2-recovery 43,
supervisor-session-v2 7, supervisor-session-v2-postgres 13,
supervisor-a2a-result-binding 11, supervisor-message-v2-delivery-ledger 46,
supervisor-message-v2-temporal-retention 14,
loop-orchestration-server-postgres 17, temporal-orchestration-e2e 2,
temporal-workflow-port 12, temporal-supervisor-runtime 8,
supervisor-a2a-v2-service 14, supervisor-a2a-result-key-rotation 20 (18 at
9b3dca36), temporal-bundle-replay 29 and orchestration-rollback-to-deployed
25: 373 tests in 20 files, all pass. The rest of the suite was not run on
r5 integration; the last whole-suite run is the round-5 base record above.
`bun run typecheck:a2a` passes; `bun run check` reports only the 10 known
errors in loop-fork/scripts/vertical-cleanup-*.ts.

Mutations on 2026-10-09, each applied alone and reverted byte for byte, at
r5 integration:

- Key rotation's settled check, against the 18 tests of 9b3dca36: a
  failing task-store read counted as settled (ledger `.catch(() => true)`)
  and a COMPLETED task settling without its accepted artifact both
  survived (18 pass); a missing task counted as settled was killed (2
  fail). Against the 20 tests: the read-failure mutant fails "a settled
  check that cannot read the A2A task store …", the COMPLETED mutant fails
  "a COMPLETED A2A task without the message's accepted artifact …", the
  missing-task mutant still fails 2, and any accepted artifact settling
  every binding of its task fails 2 (the retire test and the COMPLETED
  test).
- Replay claims re-run (see "In-flight Temporal executions across a bundle
  change"): a doubled retry delay and an added timer reproduce as recorded;
  a one-node task graph limit fails the six two-node graph replays with or
  without the bundle regenerated; a refused `claim` signal (task graph, and
  V2 message), with the bundle regenerated, replays clean and fails only
  the three live handoffs, which corrects the earlier claim.
- Rollback-to-deployed claims above re-run on 25 tests: all reproduce,
  except two counts made on 20 tests (the deployed phase on this build's
  bundle and `workflowFailureErrorTypes` each fail all 4 Temporal runs now)
  and the vendored dde60215 parser refusing `tokenEnv`, which fails 3 tests
  (the blob pin, its rolled-back config and the pre-activation shape).

2026-10-09 on claude/fix6-replay-coverage (from
claude/fix-integration-r5-2026-10-06 at 9b3dca36), task-owned Temporal dev
servers, no live state: temporal-bundle-replay 74 tests, all pass (3 fixture
checks, 60 history replays, 2 replay controls, 2 recorded-answer runs, 7 live
handoffs; about 140 s). Also run, unchanged and all passing:
workflow-replay-corpus (7), orchestration-rollback-to-deployed (25),
governess-beat-workflow (7), governess-temporal-journal (8),
temporal-workflow-port (12), supervisor-message-v2-temporal-retention (14).

## Dead-run workspace release

A run hands its workspace back (`workspaceReleasedAt`) only when its tmux
session is positively gone and no recorded process of the run can still be
live. The same evidence is used by `loop reconcile stopped-run|failed-terminal
<runId>`, the launch auto-release of a dead stopped or failed run, the clean
teardown's own handback, and startup GC. Recorded processes are:

- the run pid and launch-attempt pid (manifest), and the Codex app-server;
- the bridge worker (`bridge-worker.json`) and each `run-processes/` entry
  (bridge MCP processes);
- each agent pane's process GROUP (`run-processes/pane-<pane>-<pid>.json`,
  written at launch, on a resume that re-attaches, and by the teardown before
  its session kill; never the governess pane);
- the process GROUP of every descendant of an agent pane process that is not
  in the pane's group (`run-processes/agent-group-<pgid>.json`). The real
  CLIs start their tool subprocesses outside the pane group: Claude Code runs
  each Bash tool shell as a session leader, and Codex runs each exec command
  and MCP server in a group of its own. These groups are found by a ppid walk
  over one `ps -axo pid,ppid,pgid,lstart` snapshot while the CLI is still the
  parent: at launch, on a re-attach, on every governess cycle (at most every
  5 s), and by the teardown right before its session kill. A pane process is
  walked only while it is provably the recorded one (same group, started by
  the record). A group is provably the recorded one while some member started
  by the record's instant lives; each snapshot moves the instant of every such
  record (pane or descendant) up to itself, carrying identity forward after
  the original members exit. Records of groups that are gone are pruned by
  later snapshots;
- each claimed utility job's worker process GROUP (`utility/jobs.jsonl`; a
  worker is spawned detached, so its group id is its pid).

A recorded group is live while any member exists, even after its leader is
gone. A live process that provably started after the recorded instant and
holds the group's id is not the group (a pid is never allocated while a group
with that id exists).

A teardown signals the utility workers' groups (identity: the worker command
with this exact run directory, epoch and job id) before the session kill.
Right before the kill (after the beat close, when Temporal is on) it records
the agent panes and their descendants' groups. After the kill it ends the
worker groups and every recorded agent group that is provably the recorded
one in that snapshot (one that is not is logged `agent-group-unverified`,
never signalled, and still blocks the release while it lives): SIGTERM, a 3 s
grace, SIGKILL, a 1 s wait. Right before each signal
round every agent group is re-identified on a fresh process table: it is still
the recorded group only while some member started by the snapshot instant
lives (a reused group id has only later members), and a target that no longer
is is reported `unverified` and never signalled. The handback then re-reads
every record. Stale recovery ends a timed-out or stale-epoch worker's group
the same way (re-identified before its SIGKILL). Startup GC writes a handback
only on the full evidence above; a never-bound launch it cannot release yet
stays active, so the next GC judges it again. `loop reconcile` re-verifies a
recorded handback on the full evidence before it answers `already-released`.

`bridge-worker.json` never stops naming a live process while a worker may be
starting: before the spawn it names the spawner (`"pending": true`), right
after it the new worker, and a worker that finds a record naming no live
process records itself.

### Dead-run release: accepted residual risks (2026-10-10)

The owner accepted these on 2026-10-10 when choosing to close the remaining
review gap with the process-group repair and then install:

- A socket-less legacy run is judged on every candidate socket plus all
  recorded evidence being dead.
- A torn last `utility/jobs.jsonl` line older than 60 s is ignored.
- A malformed complete `utility/jobs.jsonl` line blocks release until it is
  repaired.
- A recycled pid (or process group id) can falsely block a release; it never
  falsely grants one.
- Utility workers started by the old binary (ea968d82) lack the claim-time
  self-cancel on a terminal run.
- A resume or re-stop between a release's read and its write is not modelled.
- Startup GC pays for tmux probing of each candidate run.

Further limits of the same repair, recorded for the owner (not part of the
2026-10-10 acceptance; they need the owner's decision):

- Runs launched before pane records existed have none: until a resume
  re-attaches (or, for a run that recorded its socket, a governess started
  from this binary tears it down), they are judged as before, on session
  absence plus the other evidence. A governess already running from the old
  binary tears down with the old code and takes no descendant snapshots.
- A tool subprocess is tracked through its parent chain to the CLI. One that
  both leaves every recorded group (setsid) and loses that chain (its parent
  exits, as in a double fork) between two snapshots, at most about 5 s apart
  while the governess runs, is not seen. So is one started in the
  milliseconds between the teardown's last snapshot and the CLI's death on
  the hangup. If the governess is gone (crashed), no periodic snapshots are
  taken.
- Group identity before a signal is judged at `ps`'s one-second start-time
  resolution: a group id that is freed and reused within the same wall-clock
  second as the snapshot could be taken for the recorded group. A process
  older than the snapshot that voluntarily joins a newer group of its own
  session (setpgid) would make that group look recorded too.
- A worker group whose leader is gone before the teardown cannot be
  identified by its command, so it is never signalled automatically; it blocks
  the release until it exits or the operator ends it.
- Pane records are never removed: `run-processes/` gains one file per pane
  process (a respawn adds one). A malformed pane or descendant group record,
  or one naming a group id of 1 or less, is unreadable evidence: it blocks
  the release until the operator repairs or removes it.
- A pane that the manifest does not name (split in by hand) is not recorded.
- The other side of tracking descendants: a long-lived daemon a tool started
  from inside the run (a `gpg-agent` while it still descends from the CLI, a
  dev server) is run-owned once a snapshot saw it, unless one of the
  shared-process rules below applies. Its life blocks the release, and the
  teardown ends it.
- Not verified: whether the Claude or Codex CLI itself ends its detached tool
  children on a hangup. The repair does not rely on it.

### Shared processes: whose is it (2026-10-10)

How a Codex seat gets its app-server (from the code, `tmux.ts`
`preparePersistentTmuxLaunch` and `codex-app-server.ts`): each paired launch
or resume that includes Codex has its launcher process (the `loop` command)
spawn one `codex app-server --listen ws://127.0.0.1:<port>` detached (its own
session and group) and orphaned when the launcher exits. Its pid and URL are
recorded as the run's `codexAppServerPid` / `codexRemoteUrl`, and the
launcher also spawns a detached `loop __codex-tmux-proxy <runDir> ...` that
the Codex pane connects through. Nothing in the code shares one app-server
between runs or seats on purpose: the app-server object is a singleton per
launcher process, and each run has its own launcher. Sharing comes from the
process tree: a `loop` launch or resume of run B run from an agent's tool
shell in run A starts B's app-server, B's proxy and, for a private socket,
possibly B's tmux server as descendants of A's agent CLI, so A's ppid walk
recorded them as A's `agent-group-<pgid>.json`. Other long-lived processes
that can appear in an agent pane's tree: the agent CLIs' MCP servers
(`loop __bridge-mcp <runDir>` and configured ones, children of that CLI), the
bridge worker and utility workers (spawned detached from inside the tree,
their command line names their run directory), and whatever a tool starts
(dev servers, Temporal dev servers, build daemons such as Gradle, watchman,
`lms server start`, `docker` clients). The governess pane, which runs the
governess helpers, is never walked.

The rules (`src/loop/shared-process-ownership.ts`), first match wins:

1. `shared-process-skipped`: another run that is not provably dead (its
   manifest is active, or present but not a valid manifest) records the
   process or its group (manifest pid, launch attempt, `codexAppServerPid`,
   `bridge-worker.json`, `run-processes/` records, utility worker claims), or
   a member's command line names that run's directory, tmux socket, tmux
   session or `--run-id`. A record whose id is held only by processes started
   after it names a later process and does not apply. The teardown never
   signals it: not at the pre-kill collection, not the run's own
   `codexAppServerPid` cleanup, and not in any signal round (each round
   re-reads the other runs). The governess logs one `shared-process-skipped`
   line per skip with `otherRunId` and the `phase` (`cleanup`, `collect`,
   `terminate`). It is release evidence only while a member's cwd (`lsof -a
   -p <pid> -d cwd`) is inside this run's workspace root (binding root, else
   cwd) or cannot be read.
2. `ownership-unknown`: the other runs cannot all be read (a run directory,
   a manifest or a run's records unreadable), or the walked group is not in
   the process table. A walked group is then never signalled and stays
   release evidence. The run's own pane groups and its own manifest
   app-server are still judged by rule 1 alone.
3. `run-owned`: a pane group, the run's own manifest app-server, or a walked
   group with a member still descending from one of the run's live, proven
   pane processes. As before: signalled after the kill, release evidence.
4. A walked group none of whose members descends from the run's panes
   (re-parented away, to launchd): `reparented-in-workspace` (a member's cwd
   is inside the workspace) is signalled and counted as before;
   `reparented-outside-workspace` (every member's cwd read, none inside) is
   neither signalled nor counted; an unreadable cwd (or more than 32 members)
   is `ownership-unknown`.

The release evidence applies rules 1, 2 and 4 only to the run's
`codexAppServerPid` and its `agent-group-*` records, in every release path
(`loop reconcile`, the launch auto-release, the teardown's own handback and
startup GC). The teardown's `workspace-released` detail lists each live
record it did not count and the rule.

Utility worker targets are re-verified right before every signal round:
each carries the instant it was identified at (its group is still the
worker's only while a member started by then lives) and its identity (while
the leader lives, its command must still be the worker command of exactly
that run directory, epoch and job). One that fails is reported `unverified`
and never signalled.

Accepted and remaining risks of these rules (for the owner):

- A stale active manifest (a run that died without reconcile) keeps
  everything it records or names "shared" for every other run: never ended
  by them, and counted by them only while it works in their workspace. Its
  own reconcile ends this.
- One unreadable run directory under the storage root makes every walked
  group of every run `ownership-unknown` (never signalled, blocks the
  release while live) until it is repaired. This fails closed by design.
- Command-line matching is textual. A tool of this run that merely names
  another live run (`tail -f <other runDir>/governess.jsonl`, `loop status
  --run-id 7`) is treated as shared: this run's teardown leaves it running,
  and it blocks this run's release while its cwd is in this workspace. The
  operator ends it. A `--run-id` value equal to this run's own id never
  matches (ids repeat across repositories); one equal to another live run's
  id in any repository does.
- A daemon working outside the workspace (cwd elsewhere) that still writes
  into it by absolute path is not counted once it re-parented away, and is
  not ended. The same holds when the governess is gone and GC or the launch
  auto-release judges the run: every walked group has re-parented by then,
  so only the cwd rule keeps it.
- cwd is read once per judgement; a process can `chdir` later. `lsof` is
  slow (tens of ms per pid): it runs only for shared or re-parented groups.
- Other runs are read from the storage root under `HOME` and, for a run
  directory in the storage layout, from its own root. Runs kept under another
  `HOME` are not seen.
- The Codex tmux proxy and a private tmux server started by another run's
  launcher are not recorded by that run; they are recognised as shared only
  by their command lines naming its run directory or socket.
