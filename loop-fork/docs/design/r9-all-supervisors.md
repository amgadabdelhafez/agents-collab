# r9 design: every supervisor as an A2A V2 recipient (from read-only design pass at claude/fix8-defaults-on f9a38faa)

Paths are under loop-fork/src/loop.

## Blockers today

1. Only one recipient is supported.
   - Init refuses to write the section without a manifest (a2a-v2-init.ts:505-537, 638-645).
   - The parser requires the recipient to be a Loop binding (loop-orchestration-server.ts:563-575).
   - Peer routes cover only seats that share the recipient manifest (:1493-1507).
   - Senders are restricted to a2aV2.principal (:999-1008).
2. Readiness is bound to the manifest.
   - Enrollment observes the configured manifestPath (:1065-1098).
   - Provider readiness goes through LoopSupervisorDirectory (supervisor-session-v2-codex-readiness.ts:36-94, loop-supervisor-directory.ts:67-92).
   - The coordinator refuses when there is no descriptor (supervisor-message-v2-runtime.ts:1659-1668, 1800-1829), so the mailbox port is never reached. FirstAvailable already chains bridge then mailbox (loop-orchestration-server.ts:1436-1441).
3. Descriptors are scoped by the sender principal: UNIQUE(tenant,principal,recipient) (supervisor-session-v2.ts:603-613).
4. A V2 fault takes V1 down in three places. r8's degrade fix may already cover some; verify.
   - parseA2AV2 throws inside the config parse (:930).
   - A missing result-graph key refuses start (:1662-1664).
   - createDefaultRuntimeHost or an enrollment refusal aborts the server (:1187-1200, :1923-1935).

## Data model

New table `loop_supervisor_endpoint_lease_v2`, created in `PostgresSupervisorSessionV2Store.migrate`:

| Column | Notes |
|---|---|
| tenant_id, recipient | primary key |
| epoch | BIGINT, never reset |
| holder_ref | |
| kind | loop-run, claude-channel or codex-thread |
| locator_json | runDir+seat, sessionDir, or remoteUrl+threadId |
| descriptor_id, descriptor_revision | |
| expires_at, released_at | |

- **claim** runs in one transaction with `FOR UPDATE`. It refuses a live row held by another holder unless `--takeover` is given. It bumps epoch and registers or rebinds the descriptor in the same transaction, reusing register and the rebind CAS (supervisor-session-v2.ts:650-761).
- **renew and release** require a matching (epoch, holder_ref); that pair is the fence.
- **locator** must hash to the descriptor's endpointDigest (codex-readiness.ts:77-81).
- **Descriptors** live in the seat's own scope, {tenant, principalFor(recipient)}.
- **Config:** recipient becomes optional; endpointRef is per kind (`endpoint:<kind>`). No new a2aV2 keys are added, because r8's exactKeys check would reject them on rollback. With a section present, every configured supervisor is a recipient.

## Ports

- **Recipient assignment** (recipient-assignment.ts:42-64): authenticate by token and principal, then resolve the lease.
  - Live lease: assertReady in the seat scope.
  - No lease or a released lease: accept when the supervisor has a mailbox (mailbox-held mode).
  - publishResult follows the same rule (supervisor-a2a-v2-service.ts:565).
- **Readiness**, in a new supervisor-message-v2-endpoint-delivery.ts:
  - Live lease: probe by kind.
  - Expired but not released: defer within notEnrolledBoundMs, using the existing deferral (runtime.ts:341-420).
  - Released or no lease, with a mailbox: ready-for-mailbox.
- **Delivery adapters by kind:**
  - Loop run: BridgeSupervisorMessageDeliveryPort, with the directory resolving {runDir, seat} from the lease.
  - Standalone Claude Code: reuse `__bridge-mcp <sessionDir> claude` as the channel server.
    - It declares claude/channel (bridge.ts:550-556) and pushes notifications/claude/channel (bridge-runtime.ts:71).
    - Readiness comes from bridge.ts:940-994 and the probe from claude-channel-readiness.ts:54-90.
    - It needs `--dangerously-load-development-channels server:<name>` (tmux.ts:817).
    - readBridgeStatus (bridge-store.ts:749-770) gains a session.json fallback when there is no manifest.
  - Codex: probe with probeCodexThread (codex-app-server.ts:1485-1523, read or resume, no turn), deliver with injectCodexMessage (:1525).
  - Mailbox: MailboxSupervisorMessageDeliveryPort (supervisor-mailbox-delivery.ts:60-116), with wake via wakeSession (supervisor-wake-driver.ts:11-22).
- **ACK stays separate from completion.**
  - `loop a2a ack`, and V2 envelopes in `loop mailbox ack`, call the recipient route (recipient-api-client.ts:43-127).
  - V2 ids do not match the V1 reconciler regex (supervisor-mailbox-consumption.ts:28).
  - Completion means a published result.

## Enrollment

- **Routes:** `{routePath}/sessions/{claim,renew,release}`. Each needs a bearer token, and identity.supervisorId must equal the requested id.
- **Renewal:** generalize ConfiguredA2AV2SessionEnrollment (:1214-1288) to iterate the live leases, on the existing sweep (:1332-1420); no new scheduler.
  - It observes the runDir, the session dir's readiness file, or the Codex probe.
  - If an observation fails, the TTL lapses.
  - A terminal run is released by the server.
- **Loop runs:** a `--a2a-as supervisor:x` launch flag claims once the manifest has its session ids.
  - Release happens in the teardown hooks (paired-loop.ts:565-580, tmux.ts:3684-3700, reconcile stopped-run cli.ts:375-430) and `loop stop` (fix8-launch-startup).
  - It never masks an error and never fails the run.
- **Standalone sessions:** `loop a2a enroll --as supervisor:x --kind ...`, or the MCP tools a2a_enroll and a2a_release in bridge session mode. The token comes from the supervisor's tokenEnv.
  - fix9 client identity: the bridge's acting supervisor is fixed at start from its session dir, never from tool input; tools take no identity, token or takeover field; takeover is the CLI's `--takeover` only. The client reads only the acting supervisor's tokenEnv and refuses an environment holding another supervisor's token (CLI override `--allow-multi-token-env`). A `LOOP_ORCHESTRATION_CONFIG` override must be owned by the user and not group/world-writable. See RUNBOOK-LOOP.md "A2A V2 clients: one identity, one token".

## Sending

- Each supervisor gets an SDK ingress at `{routePath}/supervisors/<id>`, generalizing the peer ingress (supervisor-a2a-v2-service.ts:969-994). `/a2a/v2` stays for the r8 recipient.
- The authenticator accepts any configured identity. `harness.dev/from` must equal the authenticated supervisorId, and grants still decide.
- `loop a2a send|status` and the MCP tools a2a_send and a2a_status use the @a2a-js/sdk client.
- `GET {routePath}/messages/<id>` returns phase, deliveredAt, acknowledgedAt and the SDK task state, for the sender's own principal only.
- Streaming and push stay false. A reply is a pushed A2A message.

## Migration

- **init with no --manifest** writes the section with no recipient, sets principal to the control principal (default: the first supervisor, printed), and uses workflowIdFormat legacy. It reports missing grant pairs and never invents them. The r8 section is unchanged.
- **Owner decisions are kept:** /healthz shows counts only, and a V2 fault disables V2 without taking V1 down.
- **Rollback:** the r8 parser fails on a section with no recipient, so the runbook restores the .bak-<stamp> copy.

## Risks

- **Mailbox and session double delivery:** a lease can appear between readiness and delivery. idempotencyKey and the per-workflow ACK cover it.
- **Desktop channels unverified:** if a desktop session can't load the channel, it falls back to mailbox plus wake.
- **Grant mesh:** every sender/recipient pair needs a grant the owner supplies.
- **Rollback caveat:** see Migration above.
- **--takeover** can evict a live holder.

## Tasks

Freeze the lease types and the route contracts first.

- **T1 lease store:** supervisor-session-v2.ts and supervisor-session-v2-postgres.test.ts.
- **T2 endpoint ports:** the new endpoint-delivery module, supervisor-session-v2-codex-readiness.ts, loop-supervisor-directory.ts, bridge-store.ts, plus their tests.
- **T3 server, config and init:** loop-orchestration-server.ts, supervisor-a2a-v2-service.ts, supervisor-message-v2-recipient-assignment.ts, a2a-v2-init.ts, orchestration-command.ts, plus their tests.
- **T4 clients and hooks:** a new a2a-session-command.ts, cli.ts, bridge.ts, recipient-api-client.ts, mailbox-command.ts, tmux.ts, paired-loop.ts.
- **T5 sandbox E2E:** tests/loop/a2a-v2-all-supervisors-e2e.test.ts.
  - Local Temporal and Postgres, two scripted run dirs (Claude, Codex) and one Claude channel session dir.
  - All 6 directed sends delivered, ACKed and completed.
  - Release, then mailbox fallback, then reclaim.
  - A competing claim is fenced.
  - Expiry defers, bounded.
  - With the ledger down, V1 stays up.
  - /healthz shows no ids.
  - A message to an id with no session goes to the mailbox and is ACKed via `loop a2a ack`.

## CONTRACTS

Frozen on `claude/fix9-contracts` (from `claude/fix-integration-r8-2026-10-11` e2fa0507). Builders import these files and do not edit them; a change goes back through this branch. Each file holds types, interfaces and pure helpers only; the locator resolver reaches the filesystem only through an injected interface. `tests/loop/supervisor-endpoint-contracts.test.ts` pins the decisions, and every guard was mutation-proved (28 mutants in f6466b8e, 35 more for the locator security hardening).

| File | Owns | Used by |
|---|---|---|
| `src/loop/supervisor-endpoint-lease.ts` | Lease row type, kinds, id-only locators, fence, `SupervisorEndpointLeaseStore` (claim/renew/release/resolve/list), claim and fence decisions, the server-side locator resolver | T1 implements the store; T2, T3 and T4 read it |
| `src/loop/supervisor-message-v2-endpoint-contract.ts` | The one routing table, readiness states, per-kind adapter interface, delivery options, fixed reasons | T2 implements it; T3 wires it |
| `src/loop/a2a-v2-routes-contract.ts` | Paths, the route matcher, strict session request parsers, receipt, message status, error codes | T3 serves the routes; T4 calls them |

### Lease decisions

- **Claim** is allowed when there is no row, when the lease is expired or released, or when the claimant is the same holder.
  - A live lease held by another holder refuses with `held` unless `takeover` is set.
  - Every allowed claim bumps the epoch. The first claim gets epoch 1.
  - An epoch that would pass `MAX_SAFE_INTEGER` refuses instead of wrapping.
- **Fence:** renew and release need a matching (epoch, holderRef).
  - Expiry alone never fences. An expired lease whose epoch nobody bumped can still be renewed by its holder.
  - Renew refuses a released lease. Repeating a release with the same fence is an idempotent `released` with `changed: false`.
- **Descriptor:**
  - endpointRef is `endpoint:<kind>`.
  - endpointDigest is the sha256 of the locator's canonical JSON (sorted keys). Readiness re-derives it from the lease. This differs from the manifest-bound r8 descriptor, which hashes the remoteUrl or channel server.
  - The provider is set by the kind, or by the seat for `loop-run`.
  - A Codex sessionRef must be `session:<threadId>`.
  - The descriptor's expiresAt equals the lease's.
- **Locators** carry ids only (see Locator security below). The digest covers those ids, so the r9 descriptor binds which run, session or thread, and the resolved path or URL is re-derived on every use.
- **TTL** is 1000 to 86,400,000 ms, the same bounds as `a2aV2.sessionTtlMs`. The server defaults to sessionTtlMs.
- **Store outage:** the store rejects with `SupervisorMessageV2ReadinessUnavailableError`, never with driver text.

### Locator security

Added on top of f6466b8e after a security review. A locator is untrusted caller input: the server never reads a path or dials a URL that a caller supplied. This supersedes the Data model's `locator_json` line (runDir+seat, sessionDir, remoteUrl+threadId).

| Kind | Locator (exact keys) | Server derives |
|---|---|---|
| loop-run | `{kind, repoId, runId, seat}` | `<home>/.loop/runs/<repoId>/<runId>` and its `manifest.json` |
| claude-channel | `{kind, sessionId}` | `<home>/.loop/sessions/<slug>/<sessionId>`, where slug is the lease recipient without `supervisor:` |
| codex-thread | `{kind, repoId, runId, threadId}` | the run as above; the URL is the manifest's `codexRemoteUrl` |

- **Roots** come from the server's own home (`supervisorEndpointRoots`), never from a request.
- **Ids:** repoId `^[a-z0-9][a-z0-9-]{0,127}$`, runId and sessionId `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`. None admits `/`, `\`, NUL, `.` or `..`. A locator with a path or URL key (runDir, sessionDir, remoteUrl) is refused as an unknown key.
- **Containment:** `realpath(<root>/<segments>)` must equal `realpath(<root>)/<segments>` exactly. That refuses a symlink escape and any symlink below the root, including an alias of another run or another supervisor's session. The root itself may be a symlink. The run's `manifest.json` gets the same check.
- **Manifest binding:** the manifest must have `repoId` and `runId` equal to the locator's and `a2aSupervisorId` equal to the claiming supervisor. T4's `--a2a-as supervisor:x` writes `a2aSupervisorId`; a run without it cannot be claimed. The principal is `principalFor(supervisorId)` from the server config, never from the manifest. For codex-thread, the manifest's `codexThreadId` must equal the locator's threadId.
- **Codex URL:** exactly `ws://127.0.0.1:<port>` or `ws://localhost:<port>` (optional trailing `/`, port 1-65535), matched on the raw string. Refused: other hosts, IPv6 and IPv6-mapped forms, numeric or short IPv4 spellings, `wss:`, userinfo, any path, query or fragment, and no explicit port. The client must not follow a redirect: a 3xx upgrade fails the probe.
- **Re-validation:** `resolveSupervisorEndpointLocator` is the only place a locator becomes a path or URL. It runs on every claim, every renew (on the stored locator, after the fence passes), and every readiness check, probe and delivery. Nothing caches its result. Release never resolves, so a holder can always let go.
- **Refusals:** `SupervisorEndpointLocatorError` with a fixed message and a reason for logs (`invalid`, `unresolved`, `not-contained`, `foreign-manifest`, `thread-mismatch`, `remote-url-refused`).
  - claim and renew return `{status: "locator-refused", reason}`; renew then extends nothing and the lease lapses by TTL.
  - The route answers `locator-refused` (403) with no reason, so it does not disclose whether a path exists.
  - A live lease whose locator is refused still routes `endpoint`: readiness is unready (`locatorRefused`) and delivery is a transient failure. It never falls through to the mailbox.
- **I/O:** the resolver touches the filesystem only through the injected `SupervisorEndpointFs` (`realpath`, `readJson`), so the contract module still reads nothing by itself. T1's store takes the resolver as `SupervisorEndpointLeaseStoreDeps.resolveLocator`; T2 takes it as `SupervisorEndpointDeliveryOptions.resolveLocator`; adapters receive only the freshly resolved endpoint.

### Endpoint routing

`decideSupervisorEndpointRoute` is the only rule. Readiness, delivery and recipient assignment all use it.

| Lease state | Mailbox | Route |
|---|---|---|
| live | any | endpoint |
| expired | any | defer |
| released or none | yes | mailbox |
| released or none | no | none |

- **endpoint:** delivery goes through the kind's adapter only. A transient failure there retries; it never falls through to the mailbox.
- **defer:** expiry uses the existing not-enrolled deferral, measured from expiresAt. It needs no new scheduler.
- **Scope:** lookups use the seat's scope, {tenantId, principalFor(recipient)}.
- **Reasons** are fixed and opaque.

### Routes

All routes sit under `a2aV2.routePath`. The bare routePath and the r8 sub-routes (/seats/, /assignment, /result-graph, /recipient) are unchanged, and /healthz stays counts only.

| Method | Path | Rule |
|---|---|---|
| POST | `/sessions/{claim,renew,release}` | The bearer identity's supervisorId must equal the body's supervisorId. |
| POST | `/supervisors/<slug>` | The SDK JSON-RPC ingress. The slug is the id without `supervisor:`. `harness.dev/from` must equal the authenticated id, and grants decide. |
| GET | `/messages/<messageId>` | The id is the message's V2 **workflow id** (the `workflowId` a send returns), URI-encoded; an A2A message id is not looked up. The route answers only within {route tenant, authenticated principal}; any other id gets a 404, and a ledger that cannot answer gets 503 `v2-unavailable`. |

- **Agent card:** none is served. Clients build the card with `agentCardFor` and use `ClientFactory.createFromAgentCard`.
- **Session bodies** use exact keys (claim takes optional takeover and ttlMs; renew takes optional ttlMs) and are decoded by `parseA2AV2SessionRequest` on both sides. A claim's locator is ids only.
- **Receipts** never echo the locator.
- **Message status** returns phase, deliveredAt, acknowledgedAt, taskState (the SDK enum name, or null) and workResultCompleted. workResultCompleted is true only for TASK_STATE_COMPLETED, so delivery, the read ACK and completion stay three separate facts.
- **Errors** use the existing `{ error: { code } }` envelope with the statuses in `A2A_V2_ROUTE_ERROR_STATUS`.
  - `lease-held` adds the holder summary.
  - `lease-fenced` adds the reason.
  - `locator-refused` (403) carries no detail.
  - `v2-unavailable` (503) means V2 is disabled by a fault or its store cannot answer. V1 is unaffected.

## Integration (claude/fix-integration-r9-2026-10-11)

T1 to T4 merged with `--no-ff` onto `claude/fix9-contracts` without textual conflicts. The integration wires the real parts together and fixes what the sandbox E2E (T5) found.

### Wiring

- **Lease store:** `defaultA2AV2EndpointFactories.connectLeases` opens T1's store from the service's own session store (`sessions.endpointLeases`), so a claim's descriptor register or rebind runs on the same connection and under the same rebind authority. The session store's `migrate` creates the lease table; the service closes the connection.
- **Endpoint delivery:** `defaultA2AV2EndpointFactories.endpointDelivery` builds T2's `SupervisorEndpointMessageV2Delivery`, with the V1 mailbox writer behind the V2 envelope. The mailbox wake is the existing wake sweep's; no wake is added.
- **One set of kind adapters per server** (`A2AV2EndpointFactories.adapters`, default `createSupervisorEndpointKindAdapters()`) serves delivery, the provider readiness of a lease-backed descriptor, and the lease sweep's observation.
- **Provider readiness:** `LoopCodexSessionV2ProviderReadiness` gets T2's `SupervisorEndpointDescriptorReadiness`, which reads the lease store once it is open. Before that, or without one, a lease-backed descriptor is not ready. Without it, every live lease was unreachable for the recipient route and for result publication.

### Defects found and fixed

- **An expired lease was never renewed.** The sweep's observation went through delivery routing, which reports an expired lease as `deferred`, never `endpoint-ready`. So a lease that lapsed while its session was down, or while the server was down longer than the TTL, stayed expired after the session came back. The observation is now the lease's own endpoint check: descriptor identity, a fresh locator resolution, then the kind's no-turn probe.
- **A ledger outage on `GET /messages/<id>` answered 404.** The route treated every `assertStartIntent` failure as "no such message". The ledger now throws `SupervisorMessageV2StartIntentScopeError` (same message) for absent or foreign; anything else is 503 `v2-unavailable`, as the route contract says.
- **`loop a2a send` reported a refused turn as accepted.** The SDK returns a FAILED task when the server's executor refuses the turn (an invalid policy, for one). The client now throws, with the server's reason in the error detail.

### Found, not changed (owner decisions)

- **Completion is control-principal only.** The result-graph and assignment routes accept only `a2aV2.principal`, so a message whose sender has another principal can be delivered and acknowledged but never completed. T5 runs the three session supervisors under the control principal.
- **`maxDeliveryAttempts` above 20 is accepted by the config parser (up to 100), but the message workflow refuses it.** Every V2 send then fails. This predates r9.
- **A recipient can see a message before its delivery is recorded.** A Claude target's first attempt only queues the entry (no provider acceptance), so the delivery is recorded by a later attempt, which the V2 recovery sweep drives every 30 seconds (the ingress default; no config key sets it). A Claude session sees the pushed entry, and a mailbox reader its envelope, before that. An acknowledgement in that window is refused and must be retried. This predates r9 for an r8 Claude seat; r9 makes every Claude session and channel a target.
- **`loop a2a status --message-id` takes the workflow id** that send prints, not the A2A message id; see the route table.

## Slow send reported as refused (claude/fix-a2a-send-compiled, 2026-10-11)

On the live host, the installed r9b binary (`c3d670c1`) printed "send refused or the server is unavailable; nothing is claimed delivered" for `loop a2a send --as supervisor:harness-desktop --to supervisor:portfolio-coordinator`. It was the first V2 send after the service restarted. Sends run from source afterwards succeeded, so the failure was first taken to be specific to the compiled binary. It was not.

- **The server had accepted it.** The recipient's mailbox holds `live-a2a-v2-smoke-20261011`, written at 06:35:14Z, six seconds after the client gave up.
- **The server answers a send only after its synchronous work.** That work is the ledger intent, the Temporal start and queries, and the first delivery attempt (the mailbox write). On the live host, with remote Temporal, the time from the task's arrival to its mailbox write was about 3 s for one source-run send and about 15 s for another. The second one succeeded only because it used the SDK's fetch, which has no timeout.
- **The client gave a send 10 s** (`AbortSignal.timeout`). The catch-all around the SDK call discarded the `TimeoutError` and reported a refusal.
- **The binary is not the cause.** The same `c3d670c1` bytes, and binaries rebuilt from `dca155ba`, send, report status and acknowledge correctly against a throwaway server (local Temporal, Docker PostgreSQL). That holds in a minimal configuration and in one shaped like the live config (per-supervisor principals, the pre-06:34Z grants). A loopback proxy that holds the send's answer for 12 s reproduces the live error exactly with the r9b-equivalent binary. The underlying cause it shows is `TimeoutError: The operation timed out.`

What changed:

- **A send has its own 60 s budget** (`A2A_SEND_TIMEOUT_MS`). The other requests keep 10 s.
- **A timeout is no longer reported as a refusal.** The error says the server may have accepted the message and names the `--message-id` to re-send. The server deduplicates by message id, so a re-send is safe: it returns the same workflow id and writes no second mailbox entry.
- **Every client catch keeps its underlying error.** `safeErrorCause` keeps the error's name, message and code in `detail.cause` (or `cause`), with the token and any `Bearer` value redacted and no headers. This covers the send, the JSON routes, the recipient route and ack refusals. The CLI and the bridge's tools print it.
- **`bun run test:compiled-a2a`** builds the binary into a scratch directory, nothing installed. It then runs `tests/loop/compiled-binary-a2a.test.ts`, which tests send, status and ack through the built binary for both the server and the client, including the 12 s slow-answer case. The file is skipped unless `LOOP_COMPILED_BINARY` is set.

Not changed: why the live service's send path takes up to about 15 s (Temporal queries and the delivery attempt run inside the request). The 10 s budget on `status` and on the recipient route (`ack`) is also unchanged, and either can hit the same limit on a slow host.

## Send latency (claude/fix-a2a-send-latency, 2026-10-11)

Later the same day, successive live V2 sends from `supervisor:harness-desktop` to `supervisor:portfolio-coordinator` answered in about 3 s, 15 s, 18 s and 66 s. Every message was delivered.

Evidence (live, read only):

- **The ledger is tiny.** 4 start intents, 4 delivery rows, 4 A2A tasks, no lease or readiness rows. Index scans dominate. Full scans (hypothesis d) are ruled out.
- **Each delivery succeeded on its first attempt** (lease fence 1). No readiness or not-enrolled wait (hypothesis c).
- **Every step of the send was slow, not one step.** Times from each task's arrival (`status_timestamp`): the workflow started 4 to 9 s later, the lease was claimed 2 to 23 s later, the delivery completed, and the task was saved 5 to 53 s after arrival. On the queue, workflow tasks took 0.3 to 5 s. Workflow tasks on the same queue in September took 10 to 100 ms. The worker logged three workflow tasks over 5 s (TMPRL1104) at 06:52, 06:53 and 07:02, when no send was in flight. Only the 30 s recovery sweep was querying then.
- **Only one worker polls the queue**, and only 9 executions run on it. Old workflows replaying (hypothesis a, as a backlog) is ruled out.
- **The host was saturated.** Load average was 158 to 167 on 18 cores. The Docker VM (4 CPUs) was shared with about 14 test PostgreSQL containers.

Root cause: the send answered only after the whole first delivery attempt. That attempt is about 25 serialized remote calls: about 10 PostgreSQL statements, about 12 Temporal RPCs including 7 queries that each need a workflow task on the single worker, the mailbox write, and the A2A task save. The answer time was the sum of every hop's latency. On a saturated host each hop cost 0.1 to 1.5 s, and a workflow task up to 5 s. Meanwhile the 30 s recovery sweep made about 10 calls per open message, with 3 queries each. Open messages include every delivered message not yet acknowledged, and mailbox-only recipients never acknowledge through V2. So that load grows with every message and competes for the same worker and database (hypotheses b and e). A local throwaway server reproduces it at host load about 160: 0.5 to 7.5 s per send before the change, 0.05 to 0.9 s after it (separate load windows). At host load about 25, alternating the two built binaries, the r9b build answered in 0.3 to 1.3 s at the client and this build in 0.3 to 0.7 s (26 to 117 ms on the server). So host saturation made each hop slow, and the number of hops the answer waited on multiplied it.

What changed:

- **A send answers on durable acceptance.** That means the ledger intent plus the workflow start. A new execution's start result is its state, so the send makes no status query. The first delivery attempt runs after the answer, under the same fenced lease as every recovery attempt. A sender retry, or a sweep that meets the attempt in flight, cannot deliver twice. One attempt per workflow is in flight per process (`SupervisorMessageV2DeliveryAttempts`). A failure is logged with the workflow id and left to the recovery sweep. The task state is SUBMITTED either way, and delivery is still not acknowledgement. There is no new transport or scheduler.
- **The service drains in-flight attempts (up to 10 s) before it closes its stores.** An attempt cut short is the next start's recovery sweep's to converge.
- **The sweep asks one query per open message.** A new V2 query, `recovery_status`, answers both status and delivery_pending. It is a query only, so it adds no history and is replay safe. A non-V2 answer falls back to the two old reads, so conflicts are reported exactly as before.
- **`LOOP_A2A_V2_TIMING=1` (debug only)** times every port call on the send path, every HTTP request and each reconcile pass over 50 ms, and reports main-thread stalls over 100 ms, all to stderr. Lines carry method names and workflow-id suffixes only.

Tests: `tests/loop/supervisor-message-v2-send-latency.test.ts`. A send whose delivery takes 3 s answers within 2 s. Six repeated sends, with a sweep between each, each answer within the bound, the last no slower than the first, and each makes the same number of engine and ledger calls. A retry while an attempt is in flight delivers exactly once. Background failures are logged and recovered. A sweep over delivered messages makes one state query each.

Not changed: host saturation itself, the sweep's per-message start adoption (the existing recovery contract detects foreign and other-type executions there), and the 30 s sweep period.
