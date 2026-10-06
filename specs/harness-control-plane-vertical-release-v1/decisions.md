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
