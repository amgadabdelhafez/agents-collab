# Decisions: harness-control-plane-vertical-release-v1

This is the decision record for the A2A V2 / application PostgreSQL / Temporal
control plane. It follows the `runs/<task-id>/decisions.md` form. This feature
has no run folder, so the record sits next to its spec. Entries are
append-only. To change a decision, add a dated entry that supersedes the old
one.

## 2026-10-05: owner decisions on the r2 review candidates

The user accepted these nine decisions on 2026-10-05. Each fix2 commit on
claude/fix-integration-r2-2026-10-05 (40097564) named its choice a "candidate
pending owner decision". These decisions settle those candidates.
"Implemented on r2" means a commit reachable from 40097564. r2 is not merged
into main and is not installed. "Assigned" names a branch created for the
follow-up. All assigned claude/fix3-* branches pointed at 40097564 with no
commits of their own when this was written (observed 2026-10-06T03:43Z). An
assigned item is decided but not implemented.

1. **Result graph ID: derived from the message, keyed.** The result graph's
   workflow ID is derived from (tenant, principal, messageWorkflowId). It must
   become a keyed hash, using a host secret, and a tool to compute it must
   exist.
   - Rationale: task-graph.v1 carries no tenant or message identity, and the
     assignment body used to name the graph. A message could therefore bind to
     another message's or another tenant's graph. Deriving the ID changes no
     message, start-intent, task-graph.v1 or HTTP body format (2b1b1893). The
     acceptance did not record a rationale for the key. With an unkeyed
     sha256, anyone who knows the three inputs can compute the ID. Whoever
     starts a graph must use the derived ID, which is why a tool is required.
   - Implemented on r2: the unkeyed derivation (2b1b1893, after the 65587c10
     port).
   - Assigned: the keyed hash and the tool, on claude/fix3-graph-id-keyed. The
     host secret is named by an environment variable only, following the
     loop-orchestration-server rule that rejects inline secrets. A keyed
     derivation changes the ID of every message. That branch must define and
     test what happens to bindings and reservations recorded under the unkeyed
     ID.
2. **Retired resultArtifacts shape fails startup.** An a2aV2.resultArtifacts
   entry in the old shape {artifactRef, commit, path, repositoryRoot} refuses
   startup with the exact migration message "add graphWorkflowId and
   graphTaskId ..." (loop-fork/src/loop/loop-orchestration-server.ts:302).
   - Rationale: accepting the old shape would restore "any artifact verifies
     for any task" (2b1b1893).
   - Implemented on r2: 2b1b1893. No follow-up branch is needed.
3. **Claude result dedupe slot = message type + dedupe_key, in the store.**
   A Claude reply with reply_to and type "message" or "decision" gets one
   durable effect per inbound message, type and dedupe_key. The store enforces
   this, so the double notification (MCP channel plus tmux doorbell) is kept.
   A lint or warning for keyless progress replies is added.
   - Rationale: e4efbae2 rings the channel even while Claude has a live tmux
     pane. The channel guard was rejected on
     claude/fix-claude-duplicate-delivery. The store makes a duplicate result
     effect impossible however Claude is notified (b42a326c). Without a key, a
     progress reply and the later result reply of the same type share one
     slot, so the result is not delivered once the progress reply has reached
     its recipient (loop-fork/src/loop/bridge-store.ts:784-788). The lint
     exists to catch this.
   - Implemented on r2: the store-level slot and the guidance text (b42a326c).
   - Not implemented: the lint or warning. No claude/fix3-* branch whose name
     covers it was observed.
4. **ACK retry for every sender.** If an earlier ACK was dead-lettered,
   expired or superseded, any sender (Claude, Codex, oss) may send it again.
   - Rationale: those ACKs never reached their recipient. Keeping them in the
     ACK slot blocked a retry that could still deliver (b42a326c).
   - Implemented on r2: b42a326c. Test "a dead-lettered ACK from Claude or
     Codex does not block a retry". No follow-up branch is needed.
5. **terminal_outcome column, with 'acknowledged' naming.** The
   loop_supervisor_message_v2_start_intent table gains terminal_outcome
   (CHECK in 'acknowledged', 'canceled', 'dead-lettered', 'exhausted',
   'terminated') and terminal_at. A recipient ACK is stored as
   'acknowledged', never as completion.
   - Rationale: a canceled, dead-lettered or exhausted message has no
     completed delivery. After retention purged its execution, recovery used
     to start it and deliver it again (3f7a70f2). The name 'acknowledged'
     keeps a delivery or read ACK from being recorded as work completion
     (4d98d97d).
   - Existing rows are not backfilled. The migration is additive and
     idempotent (ADD COLUMN IF NOT EXISTS, run by migrate()), and existing
     rows read NULL, which means no outcome observed. A closed execution that
     Temporal still holds gets its marker on the next recovery sweep. An
     execution purged before this change, with no completed delivery, cannot
     be told apart from a lost start and is still restarted.
   - Edge case: the CHECK list is part of ADD COLUMN IF NOT EXISTS. A
     database already migrated by a build of 3f7a70f2, which used 'completed',
     keeps that old list and would refuse 'acknowledged'. No migration
     handles this. No record shows that such a database exists. 75b4ef92 and
     main have no terminal_outcome column.
   - Implemented on r2: 3f7a70f2 and 4d98d97d.
6. **Deployment discriminator in workflow IDs: ADOPT.** V2 workflow IDs gain a
   deployment discriminator.
   - Rationale: a V2 workflow ID is unique per Temporal namespace, not per
     deployment. Two deployments in one namespace can collide on an ID.
     r2 only guards against this, through a foreign-task-queue conflict
     (4d98d97d) and a namespace and task-queue binding at composition
     (31e5deba). It left the format unchanged until this decision.
   - Assigned: claude/fix3-workflow-id-deployment. This is a durable-format
     change. That branch must keep in-flight workflows and recorded start
     intents under the current ID format working, or ship a tested migration.
7. **Recovery skip: NARROW to conflicts only.** Today any failing record is
   skipped and service start proceeds (72d188df). Only a conflict, meaning an
   ID held by another execution, may be skipped while the host still starts.
   - Rationale: the skip exists so that a foreign-held ID cannot keep this
     host down (72d188df, 4d98d97d). The acceptance did not record why other
     failures are excluded. Inferred: skipping them would hide real recovery
     faults behind a running service.
   - Assigned: claude/fix3-recovery-narrowing.
8. **Readiness-outage deferral: keep, and add a log line, a counter and a
   separate bound.** When the readiness store is unavailable, the delivery
   stays pending and spends no attempt (eefcbb0b). It now also logs, counts,
   and has its own bound, separate from the delivery-attempt policy.
   - Rationale: a store outage must not dead-letter messages (eefcbb0b).
     The acceptance did not record why the additions are needed. Inferred:
     without a log, counter and bound, the deferral is invisible and has no
     limit.
   - Implemented on r2: the deferral (eefcbb0b). Assigned: the log line, the
     counter and the bound, on claude/fix3-readiness-outage-bound.
9. **Session leftovers.** Set a retention policy for rebind receipts. Fix the
   not-ready-after-renewal gate. When a peer is stopped at start, degrade
   that seat only.
   - Rationale: the acceptance did not record one. On r2, start refuses when
     any configured seat cannot be enrolled (6615d452). The test "the
     orchestration server refuses to start when a configured seat cannot be
     enrolled" pins this, so one stopped peer keeps the whole host down.
   - Assigned: claude/fix3-session-retention.

Also observed: claude/fix3-doorbell-starvation, with no commits. This record
does not map it to a decision. The open-defect state for these items is in
status.md, under "Open review defects at r2".

## 2026-10-05: decision 6 follow-up, a rollback-safe workflow ID format

The entry after this one corrects four of its claims: the Q2 answer, the
default's effect on decision 6, the scope of "rolling back is safe", and the
return to legacy when rows never settle.

This is not an owner decision. Owner question Q1 (is a one-way upgrade
acceptable for the deployment ID?) is unanswered, so
claude/fix4-deployment-rollback-safety takes the option that needs no answer:
rolling back stays safe, and nothing becomes one-way without an explicit
operator step. It builds on claude/fix-integration-r3-2026-10-05 (ef570282)
and is not merged or installed.

- Operator switch: `a2aV2.workflowIdFormat`, "legacy" or "deployment". When it
  is omitted, the host uses the format the ledger database records, or
  "legacy" when none is recorded. "deployment" is always an explicit opt-in.
  In both formats the host reads, recovers and deduplicates both ID formats.
- Durable marker: the loop_supervisor_message_v2_schema_marker row
  'workflow-id-format.v1' records the format (column value) and the build that
  set it (column build_id). A host refuses to start on a recorded format it
  does not support, with the exact message: V2 delivery ledger records
  workflow id format "<format>" (written by build <build>), which this build
  does not support; it supports "legacy" and "deployment". Run a build that
  supports the recorded format.
- Database guard: a BEFORE INSERT trigger on the start-intent table refuses,
  for every writer (including a pre-discriminator build), a start intent in
  any format but the recorded one. It also refuses a legacy-format intent for
  a message already held under a deployment ID.
- Procedure. (1) Install this build with the switch unset. It writes the
  legacy ID, byte for byte, with deployment NULL: the row a
  pre-discriminator build writes. Rolling back to that build is safe. A test
  replays that build's SQL against the rows. (2) After every host that shares
  the ledger database runs this build, set "deployment" and restart. From then
  on, a pre-discriminator build cannot record a start intent. Its recovery
  also refuses the first deployment-format row it reads. (3) To go back, set
  "legacy". Start is refused while any deployment-format start intent has no
  terminal outcome, with the exact message: V2 delivery ledger cannot return
  to legacy workflow ids: <n> deployment-format start intents have no
  terminal outcome. Keep a2aV2.workflowIdFormat "deployment" until they
  settle. Once they settle, the switch back is allowed.
- Limits. Deployment-format rows are never deleted. A database that ever held
  one cannot be used by a pre-discriminator build again: that build's
  recovery rejects every such row, settled or not. After a flip, the
  reversible path is this build's legacy mode, not the old binary. The
  format applies to the whole database, so hosts that share it must be
  configured alike. A host whose format another host changed refuses to
  record (trigger message) until it restarts. A database written by the r3
  build (deployment rows, no marker) defaults to "legacy". It therefore
  refuses to start until "deployment" is set or its rows settle.
- Q2 is untouched: no unauthenticated endpoint exposes the format, the
  marker or any seat ID.

## 2026-10-05: corrections to the decision 6 follow-up

This is not an owner decision. The round-4 review of
claude/fix4-deployment-rollback-safety (ae877039) found four claims in the
entry above false or unqualified. This entry supersedes them. The fixes are
on the same branch, which is still not merged or installed.

- Q2, seat IDs on unauthenticated endpoints. The entry above says no
  unauthenticated endpoint exposes any seat ID. That is false at this
  branch's base (ef570282) and on this branch. The unauthenticated GET
  /healthz body carries `notEnrolled`, the IDs of the configured A2A V2 seats
  that are not enrolled (loop-orchestration-server.ts, `orchestrationHealth`;
  the server supplies the real list). The loop-orchestration-server test
  "/healthz lists the seats that are not enrolled beside an unchanged ready
  state" pins it. It arrived with 00845464 on r3. This branch leaves /healthz
  alone. claude/fix4-peer-degrade-healthz (f3f8c2e1, not merged, review
  pending) replaces the list with a count, `notEnrolledCount`, and moves the
  seat IDs to the authenticated assignment status. The exposure stands until
  that branch lands. What this branch adds (the format, the marker and the
  build ID) reaches no unauthenticated endpoint.
- Decision 6 is off until the flip. With the switch unset, a host writes
  legacy IDs, and a legacy row names no deployment. Hosts on different task
  queues that share one ledger database therefore get none of decision 6's
  isolation. Each recovers the others' legacy start intents, and a dedupe
  key resolves to the same legacy ID on every deployment. This is the
  pre-discriminator behaviour. The workflow port's task-queue ownership
  checks still refuse an execution that another task queue already holds.
  They cannot refuse a start whose execution does not exist yet. So if one
  host records an intent and stops before it starts the workflow, another
  host's recovery can start it on its own task queue. Pinned by the ledger
  test "default legacy-write mode does not isolate deployments that share a
  database: each recovers and resolves the other's messages until the
  flip". A host now logs the format at start; in legacy format the line
  says that the discriminator is off. Decision 6 takes effect only when
  every host sharing the database sets "deployment" (procedure step 2).
- Rollback scope. "Rolling back to that build is safe" (procedure step 1)
  holds for the workflow ID path only. The ledger tests now run the real
  40097564 ledger class against a database this build wrote, not a replay of
  its SQL. Its six source files are vendored unmodified under
  loop-fork/tests/fixtures/base-era-40097564, and a test pins each one to its
  git blob ID at 40097564. Those tests show the following. In default mode
  this build mints the IDs the 40097564 contract derives. 40097564 migrates,
  recovers, takes a sender retry, records a new message and records a
  terminal outcome over those rows, and this build reads them back. After
  the flip, 40097564 can record nothing and its recovery refuses instead of
  starting. A rollback from this build (r3 plus this branch) to 40097564 has
  other limits:
  - Result bindings. This build binds results under the keyed
    `supervisor-result-graph:v3:` ID. 40097564 publishes a binding only when
    its graph is the unkeyed v2 ID, so it does not publish those results. Its
    bindResult also lets such a message be re-bound to its unkeyed v2 graph.
    Pinned by the ledger test "rollback limit: the base-era ledger does not
    publish a result this build bound to its keyed graph, and lets the
    message be re-bound to its unkeyed graph".
  - Configuration. 40097564 checks a2aV2 keys exactly, so it refuses to
    start with resultGraphKeyEnv, readinessOutageBoundMs or
    workflowIdFormat set. It also refuses a resultArtifacts entry whose
    graphWorkflowId is a keyed v3 ID. Roll the configuration back with the
    binary.
  - Temporal executions in flight. The decoded workflow bundle code differs
    between 40097564 and ef570282 in code, not only in comments. No test
    shows that the 40097564 worker can replay histories this build's
    workflow code wrote. Treat a rollback with V2 executions still running
    as unverified.
  - The other r3 changes (session receipt retention and its indexes, the
    Claude result dedupe slot, ACK retry, readiness-outage bound) were not
    reviewed for rollback.
- Returning to legacy when rows never settle. The return needs a terminal
  outcome on every deployment-format start intent in the database, whatever
  deployment owns it. A host's recovery settles only its own deployment's
  rows. Rows of a deployment that no longer runs, and any other row whose
  outcome is never recorded, keep the return refused for good. The supported
  way to settle them is to run a host on that task queue in "deployment"
  mode until its recovery records their outcomes. If that cannot happen,
  stay on "deployment". Nothing is lost by staying: once a database holds a
  deployment-format row, 40097564 cannot use it again, so after a flip
  legacy mode is not a way back to the pre-discriminator build. This build
  offers no override. Whether an operator may record such an outcome by hand
  is an open question for the owner.

## 2026-10-05: decision 7 follow-up, operator quarantine (not an owner decision)

This entry records an implementation choice on
claude/fix4-recovery-escape-path (from claude/fix-integration-r3-2026-10-05,
ef570282). It keeps decision 7 and does not supersede it. The owner has not
reviewed it.

- Problem: after the narrowing (4ab9bc3d), a recorded start that keeps
  failing for a reason other than a foreign-held ID refuses every service
  start, and nothing short of editing the database let the host start.
- Choice: recovery still never skips such a record by itself. An operator
  can quarantine it explicitly and durably:
  `loop orchestration v2-quarantine <config-path> <workflow-id> --reason <text> [--by <operator>]`,
  with `v2-quarantine-release` (same arguments) and
  `v2-quarantine-list <config-path>`. The ledger keeps who, when and why, and
  a release keeps the row as history
  (`loop_supervisor_message_v2_recovery_quarantine`). Recovery leaves a
  quarantined record alone and logs it on every start. The quarantined record
  is listed on the authenticated GET of the assignment route, never on
  /healthz. A startup refusal names each failing workflow ID and the exact
  quarantine command, and it is logged, because the service wraps the error.
- Refinement: a conflict with another workflow type under the ID on the
  host's own task queue is no longer treated as a foreign execution. Only an
  execution on another task queue (`WorkflowForeignExecutionError`) is
  skipped. A same-queue type conflict refuses startup like any other failure,
  whether that execution is running (the port's start refuses the type) or
  closed (the coordinator's status read refuses any answer that is not a
  `supervisor-message-status.v2` projection, so the other type's state is
  never recorded as this message's terminal outcome). It can be quarantined.
- Status surface limits: quarantined records are listed only where an
  authenticated V2 inspection surface exists, the assignment route's GET,
  and only for that route's tenant (one tenant's control principal never
  sees another tenant's message ids). A deployment without an assignment
  route has the start-time log lines and `v2-quarantine-list` (which needs
  the database credential) and nothing on HTTP. Nothing is added to /healthz,
  not even a count, while owner question Q2 is open.
- Rollback and mixed versions: the table is additive. A build without it
  ignores the table and refuses startup on a failing record, as 4ab9bc3d
  does, so a rollback fails closed and loses the escape. It also restores
  the r3 handling of a same-queue workflow-type conflict: a running one is
  skipped as foreign again, and a closed one is durably recorded as
  `terminated` from the other type's status. That record is not undone by
  upgrading again, and a quarantine does not prevent it, because an older
  build ignores quarantines. Before rolling back, resolve each same-queue
  conflict this build reported.

## 2026-10-06: status of the nine decisions on r4

This is a status entry, not an owner decision. It supersedes the "Assigned"
and "Not implemented" statuses in the 2026-10-05 entry above. Those statuses
were true of 40097564 when written. The decisions themselves are unchanged.

Line: claude/fix-integration-r4-2026-10-05 at
00094c661fe6c1923737318d5e39d885d993b11c ("r4"). r4 contains r3
(claude/fix-integration-r3-2026-10-05, ef570282, with the seven
claude/fix3-* branches merged) plus three round-4 branches:
claude/fix4-deployment-rollback-safety (ae877039, f50edf18; merge 6be93679),
claude/fix4-peer-degrade-healthz (f3f8c2e1, d6392ce9; merge 5f147810) and
claude/fix4-compat-and-migrations (903dfe1b; merge 00094c66). Not merged into
r4: claude/fix4-key-rotation (226e40c2, a54a21f4) and
claude/fix4-recovery-escape-path-r4 (4d3668fd to 26f91ac5).
claude/fix4-recovery-escape-path points at ef570282 with no commits of its
own. r4 is not merged into main and is not installed.

Test evidence: run on 2026-10-06 at 00094c66 with `bun run test:file`,
task-owned PostgreSQL and a local Temporal dev server. Every test named below
passed. The one failing test on r4 is listed under decision 9.

1. **Result graph ID, keyed: implemented on r4**, with one limit.
   - 3cf366e8 (merge cec4d671): HMAC-SHA256 id
     `supervisor-result-graph:v3:...` under the key named by
     a2aV2.resultGraphKeyEnv, the CLI `loop orchestration result-graph-id`,
     and POST `<routePath>/result-graph`. Existing bindings under the unkeyed
     v2 id keep publishing. 903dfe1b: the 403 `result-graph-id-reserved`
     refusal on task-graphs/start now names the replacement route and the
     CLI.
   - Tests: supervisor-a2a-result-binding "no new binding may name an unkeyed
     v2 graph, and a ledger without the key binds nothing" and "a
     body-supplied graph that is not derived from the message is refused,
     even when the host allowlists it"; orchestration-command
     "result-graph-id prints the id the server derives from the config's key
     environment, never the key, and never starts the server";
     loop-orchestration-server-postgres "the orchestration server starts a
     message's result graph under its keyed id and binds it only through the
     configured graph tasks"; supervisor-orchestration-http "a reserved
     result graph id refusal names the replacement route and the
     result-graph-id CLI".
   - Limit: r4 holds one key. Rotation strands every binding recorded under
     the old key: it stops publishing, and nothing reports it. Re-binding the
     A2A task to its new-key graph restores it. A throwaway test on real
     PostgreSQL showed this on 2026-10-06 (not committed). The procedure is in
     loop-fork/docs/RUNBOOK-LOOP.md. Previous-key support is on the unmerged
     claude/fix4-key-rotation.
2. **Retired resultArtifacts shape fails startup: implemented** (2b1b1893;
   since 3cf366e8 the message names the v3 id and the CLI). The refusal is now
   at loop-fork/src/loop/loop-orchestration-server.ts:384-388, not :302.
   Test: loop-orchestration-server "orchestration config refuses a result
   artifact in the retired shape with the exact migration".
3. **Claude result dedupe slot: implemented, lint included.** The store slot
   is b42a326c. The keyless-reply warning is d6dbd978 (merge 545334de):
   `keylessClaudeResultReplyWarning` in loop-fork/src/loop/bridge-store.ts,
   appended to the send_message result and written to stderr. The 2026-10-05
   entry said no claude/fix3-* branch whose name covers it was observed; it
   landed on claude/fix3-doorbell-starvation. Tests:
   bridge-result-reply-dedupe "a duplicate Claude result reply for one
   inbound produces one effect", "a keyless Claude message reply is flagged
   because it shares the keyless result slot" and "the keyless reply lint
   stays silent outside the Claude message result slot". A keyless progress
   reply still takes the slot; the warning tells the sender, it does not
   change delivery.
4. **ACK retry for every sender: implemented** (b42a326c; re-verified on r3
   by 903dfe1b with no fix needed). Tests: bridge-result-reply-dedupe "every
   sender's ACK retries after a dead-lettered, expired or superseded ACK, and
   holds once delivered" and "a delivered ACK holds its slot for every
   sender, even with supersede".
5. **terminal_outcome with 'acknowledged': implemented** (3f7a70f2,
   4d98d97d). The edge case in the 2026-10-05 entry (a database migrated by
   3f7a70f2 keeps a CHECK that refuses 'acknowledged') is fixed by 903dfe1b:
   migrate replaces a non-current CHECK and rewrites stored 'completed' to
   'acknowledged'. Rows with NULL are still not backfilled. Tests:
   supervisor-message-v2-delivery-ledger "migrates a ledger left by the
   3f7a70f2 build: its 'completed' CHECK is replaced and stored 'completed'
   becomes 'acknowledged'", "replaces any terminal_outcome CHECK that is not
   the current list, including hand-edited ones", "hosts replacing one
   database's retired CHECK at the same time all start", "leaves a current
   terminal_outcome CHECK in place on every migrate" and "records
   acknowledgement, not completion, when the recipient acknowledges".
6. **Deployment discriminator: implemented, off by default.** 4db6b118 (merge
   4fdc681b) adds the deployment-scoped id and the task-queue ownership check
   on every workflow port call. ae877039 and f50edf18 make the format an
   operator switch, a2aV2.workflowIdFormat, defaulting to legacy writes.
   Decision 6's isolation between deployments that share a ledger database
   applies only after every such host sets "deployment". Tests:
   supervisor-message-v2-delivery-ledger "defaults to legacy-write mode:
   mints the base-era workflow id byte for byte and records the format with
   its build", "flips to deployment ids only on explicit opt-in; afterwards
   the base-era build's writes are refused with an exact message", "refuses
   to return to legacy ids while deployment-format intents are unsettled,
   then returns once they settle", "default legacy-write mode does not
   isolate deployments that share a database: each recovers and resolves the
   other's messages until the flip" and "rollback: the real base-era ledger
   migrates, recovers, deduplicates and records over default legacy-write
   rows, and this build reads its rows back"; temporal-workflow-port
   "refuses to signal a same-ID execution owned by another task queue and
   leaves it unchanged"; loop-orchestration-server-postgres "the
   orchestration server writes its configured V2 workflow id format and
   refuses a return to legacy over unsettled intents, verbatim".
7. **Recovery skip narrowed to conflicts: implemented** (4ab9bc3d, merge
   d1724a54), with two limits. Tests: supervisor-message-v2-recovery
   "refuses startup when any recorded start fails for another reason, after
   trying every record", "starts past an ID another deployment holds, logs
   which ID and recipient, and keeps sweeping" and "a periodic sweep retries
   a failing record with bounded backoff and logs every failure transition";
   supervisor-message-v2-delivery-ledger "service start refuses a PostgreSQL
   failure for one record after recovering the others".
   - Limit: the operator sees only "Supervisor A2A V2 service initialization
     failed at runtime-host (unclassified)". No log line names the failing
     record, and r4 has no way to start past it (code reading:
     loop-fork/src/loop/supervisor-a2a-v2-service.ts:316-327 and 939-942,
     loop-fork/src/loop/supervisor-message-v2-runtime.ts:652-661). The
     quarantine on claude/fix4-recovery-escape-path-r4 is not merged.
   - Limit: any conflict at start counts as foreign, including an execution
     of another workflow type on this host's own task queue. Pinned for a
     running execution by loop-orchestration-server-postgres "the
     orchestration server starts when a recorded V2 workflow ID is held by a
     foreign execution", whose expected log line ends "already exists as
     supervisor-message.v1" for an execution on the host's own task queue.
8. **Readiness-outage deferral with log, counter and bound: implemented**
   (11b71513, merge 7074bc37; d6392ce9 ends a stale outage). Optional
   a2aV2.readinessOutageBoundMs, default 15 minutes; counts on /healthz,
   recipient ids only on the authenticated assignment GET. Tests:
   supervisor-message-v2-runtime "an outage that outlasts its bound becomes
   a retryable delivery failure that consumes attempts up to the policy
   bound", "an outage nothing observed for over two hours, with no message
   waiting on it, is over: the next failure starts a new bound", "an outage
   is measured from its start, however long a message waits on its retry
   delay" and "a store answer for one recipient does not end another
   recipient's outage"; loop-orchestration-server "/healthz reports the V2
   readiness-outage counters as counts only, without changing its state".
   Limit: state is in memory; a restart starts the bound again.
9. **Session leftovers: implemented**, with one failing test on r4.
   c41b459d and 00845464 (merge de2ae866): receipt retention (default keep 16
   and 7 days; not an orchestration config key), readiness carried across a
   renewal, and a stopped peer degraded alone. f3f8c2e1 and d6392ce9: only a
   peer that is not running or not reachable degrades, a not-enrolled
   recipient's deliveries wait without spending attempts up to
   a2aV2.notEnrolledBoundMs, and /healthz carries a count, not seat ids.
   Tests: supervisor-session-v2-postgres "PostgreSQL: a renewal prunes a
   seat's receipts older than the window beyond its latest N" and
   "PostgreSQL: renewing an unchanged seat keeps the DAG gate ready without a
   new probe or a longer freshness"; loop-orchestration-server-postgres "the
   orchestration server starts with a stopped peer seat, reports it not
   enrolled, and enrolls it from the sweep", "the orchestration server
   starts with a peer seat that is not running (no route), counts it without
   naming it, and enrolls it once its pane starts", "the orchestration
   server refuses to start when a running peer seat is refused by the
   governed rebind authority" and "a V2 delivery pending for a stopped peer
   at start neither refuses start nor reaches the provider, and waits
   without spending an attempt".
   - Failing on r4, on both runs: supervisor-a2a-v2-service "every V2
     delivery path of one service defers a not-enrolled recipient under one
     shared bound, log line, and counters". The test (f3f8c2e1) builds the
     service with `host: {taskQueue}` and no `buildId`. Since ae877039 the
     ledger refuses a missing build id, so creation fails at
     "delivery-ledger (unclassified)". The two commits first meet in r4. The
     server always passes the config's required buildId, so this is a
     test-fixture defect. It is new against ef570282, where the test does
     not exist.

The doorbell fairness work (d6dbd978, c581fb9b; merge 545334de) is not one of
the nine decisions.

## 2026-10-06: conservative choices pending owner confirmation

Not owner decisions. Two owner questions are unanswered. r4 takes, for each,
the option that needs no answer. Each stays pending until the owner confirms
or replaces it.

- Q1, is a one-way upgrade acceptable for the deployment ID? r4 avoids a
  one-way step by default. A host with a2aV2.workflowIdFormat unset writes
  legacy IDs, and the database marker records "legacy", so 40097564 can
  still be rolled back to for the workflow ID path (ae877039, f50edf18;
  tests listed under decision 6 above). The flip to "deployment" is an
  explicit operator step. After it, 40097564 can no longer use the database.
  Cost: decision 6's isolation is off until the flip.
- Q2, should unauthenticated /healthz list seat IDs? r4 lists none. /healthz
  carries `notEnrolledCount` and counter blocks only. Seat and recipient IDs
  are on the authenticated GET `<routePath>/assignment` (f3f8c2e1, merge
  5f147810). Test: loop-orchestration-server "unauthenticated /healthz names
  no seat or recipient while seats are not enrolled and deliveries wait".
  This supersedes the 2026-10-05 corrections entry's statement that the
  exposure "stands until that branch lands": on r4 it has landed. ef570282
  still exposes the IDs, so rolling back to r3 would expose them again.

## 2026-10-06: round-5 base status and record corrections

This is a status entry, not an owner decision. It supersedes the statements
named below; the decisions themselves are unchanged. The owner has not
reviewed the quarantine (decision 7 follow-up entry above).

Line: claude/fix5-base-2026-10-06 ("round-5 base"), from
claude/fix4-runbook-docs (fc8cd748, which is r4 00094c66 plus docs). It adds
claude/fix4-recovery-escape-path (4d3668fd to 26f91ac5), approved in round 4,
in merge 0ea648f9, and the test-fixture fix de5e019d. It is not merged into
main and is not installed. Still not merged anywhere:
claude/fix4-key-rotation (a54a21f4).

Test evidence: on 2026-10-06 the whole suite ran file by file at de5e019d
and at r4 00094c66, with task-owned PostgreSQL and a local Temporal test
server. Every test named below passed at de5e019d. No test fails there that
passes at r4; the 17 failures it has fail at r4 too and are outside the A2A
V2 area (status.md, "Open defects at the round-5 base").

Corrections to earlier entries:

- Branch pointers, observed 2026-10-06. claude/fix4-peer-degrade-healthz is
  at d6392ce9; f3f8c2e1 is its first commit, not its head. The 2026-10-05
  corrections entry names the branch as "f3f8c2e1, not merged, review
  pending": the branch was reviewed and merged into r4 at 5f147810, so
  /healthz carries `notEnrolledCount` and no seat IDs on r4 and on the
  round-5 base. claude/fix4-deployment-rollback-safety (f50edf18), which the
  decision 6 follow-up and its corrections entry call "not merged", was
  merged into r4 at 6be93679. Neither branch is installed.
- The 2026-10-06 r4 status entry says claude/fix4-recovery-escape-path points
  at ef570282 with no commits of its own. It now points at 26f91ac5, the
  same commit as claude/fix4-recovery-escape-path-r4.

Status on the round-5 base, where it differs from r4:

7. **Recovery skip narrowed to conflicts: implemented, both r4 limits
   addressed.** A refused start names each failing record and its exact
   quarantine command, and is logged; the service reports
   `SupervisorMessageV2RecoveryStartupError`. An operator can quarantine the
   record (`loop orchestration v2-quarantine`, `v2-quarantine-release`,
   `v2-quarantine-list`). Only an execution on another task queue is
   foreign; another workflow type on the host's own queue refuses startup,
   running or closed, and a closed one records no outcome. The merge adapted
   the quarantine command to r4's ledger: it opens the ledger with the
   config's buildId and workflowIdFormat, as the server does, and prints a
   workflow id format refusal verbatim. Tests (round-5 base):
   supervisor-message-v2-delivery-ledger "an operator quarantine lets every
   start skip a persistently failing record loudly, and its release returns
   it to recovery" and "a quarantine records who, when and why durably,
   refuses records that are not this deployment's open ones, and keeps
   release history"; supervisor-message-v2-recovery "another workflow type
   under the ID on this deployment's own queue is failed, not foreign", "a
   CLOSED execution of another workflow type on this deployment's own queue
   is failed, and records no outcome" and "a ledger row that fails the whole
   initial sweep refuses startup naming its workflow and quarantine
   command"; loop-orchestration-server-postgres "the orchestration server
   refuses to start while its own queue holds another workflow type under a
   recorded V2 id, names the quarantine command, and starts once an
   operator quarantines it"; orchestration-command "v2-quarantine records,
   lists and releases a quarantine in the configured deployment's PostgreSQL
   ledger, printing no secret" and "v2-quarantine opens the ledger as the
   server does: the config's build and workflow id format";
   a2a-supervisor-assignment-http "assignment route reports quarantined
   recovery records only to the authenticated control principal, for its
   tenant".
   - Limit: a build without the quarantine (r4 or older) ignores it and
     handles a same-queue conflict the r3 way. See the runbook's rollback
     procedure.
   - Limit: quarantines are listed only on the authenticated assignment GET
     and by `v2-quarantine-list`; nothing is added to /healthz while owner
     question Q2 is open.
9. **Session leftovers: implemented; the r4 failing test is fixed.**
   de5e019d gives the supervisor-a2a-v2-service test "every V2 delivery path
   of one service defers a not-enrolled recipient under one shared bound,
   log line, and counters" a host buildId and opts the service in to
   workflowIdFormat "deployment", because the test runs its message under a
   deployment-scoped id. Both changes were needed: with a buildId alone the
   test still failed at recordStartIntent. The ledger's build id guard and
   the legacy-write default are unchanged.

Owner questions Q1, Q2 and the hand-recorded terminal outcome remain
unanswered; the round-5 base keeps the conservative choices recorded above
(legacy write by default, no seat IDs on /healthz, no override).

## 2026-10-06: round-5 base review repair

This is a status entry, not an owner decision. It corrects the round-5 base
status entry above after review of b721681a; the decisions are unchanged.

- Full-project tsc: the round-5 base status said 282 errors, the same set as
  r4. At b721681a it was 283: the new orchestration-command test
  "v2-quarantine opens the ledger as the server does: the config's build and
  workflow id format" compared an untyped SQL result (TS2769). The repair
  types the query; tsc reports 282 again, the same set as r4 00094c66 by
  file, code and message.
- Merge 0ea648f9's message says the regenerated Temporal workflow bundle's
  decoded diff from r4 "equals" the escape path's decoded diff from
  ef570282. That holds only up to a minifier identifier rename and the
  inline source map; the code is equivalent, not byte-identical.
- Decision 7 gains a limit: a quarantine is not a terminal outcome, so a
  quarantined deployment-format record blocks every return to legacy
  workflow ids until it is released and recovery records its outcome. Test:
  supervisor-message-v2-delivery-ledger "a quarantined deployment-format
  record keeps blocking a return to legacy ids: a quarantine is not a
  terminal outcome". Documented in the runbook.
- Every quarantine command, `v2-quarantine-list` included, runs the
  server's full migrations, format marker write included. Whether the
  commands should leave the format alone remains an owner question; the
  runbook says to run them only with the running hosts' config.
- The shared not-enrolled deferral test now also runs in the legacy-write
  default: supervisor-a2a-v2-service "in the legacy-write default, every V2
  delivery path of one service defers a not-enrolled recipient under one
  shared bound, log line, and counters".
