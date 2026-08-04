# Harness memory and heartbeat

## Objective

Give governed loops durable, local-only continuity without making a memory
system or timer an authority. The implementation order is fixed:

1. update and install upstream Pickbrain, including its Pi skill and extension;
2. use Pi as the Nanny and Au Pair execution harness;
3. replace hot bridge polling with event-driven wakeups plus a persisted
   five-minute reconciliation heartbeat;
4. write pre-compaction checkpoints and promote only curated memory;
5. bake off local-only Honcho against Markdown plus Witchcraft before adopting
   any additional service.

## Existing evidence

- Upstream Witchcraft `bbae7e0` contains Pickbrain Pi-session ingestion, a Pi
  extension, and a Pi skill. The previous installed binary was `dc2f4f4` and
  lived only in `~/bin`, which is absent from the loop process `PATH`.
- Commit `2134db4` already routes Nanny and Au Pair conversations through Pi
  SDK sessions with built-in tools disabled and only brokered tools exposed.
  This slice verifies and preserves that boundary rather than rewriting it.
- Live loop 122 showed the detached bridge worker consuming 10-20% CPU while
  polling the full bridge journal. Commit `19bad72` fixes the missing Codex
  doorbell and bounds polling, but still polls every five seconds indefinitely.

## Authority boundaries

- `manifest.json`, append-only run and bridge journals, utility claims and
  epochs, exact-SHA review records, and positive OS/tmux/port checks remain the
  only operational truth.
- A doorbell is a hint. A missed hint cannot lose work because reconciliation
  rereads authoritative journals at least every five minutes.
- A heartbeat records that reconciliation ran; it never declares an agent,
  pane, process, route, or message healthy by itself.
- Pickbrain, Markdown memory, Witchcraft, and any Honcho candidate are derived,
  rebuildable retrieval projections. They cannot authorize delivery, release,
  routing, permissions, lifecycle transitions, or live mutation.
- Nanny and Au Pair remain ephemeral governed Pi sessions. Installing the
  global Pickbrain Pi extension does not grant helper sessions global history
  or bypass their bounded context capsules.
- No transcript, tool output, or model response is promoted to durable memory
  automatically. Promotion requires an allowlisted class, provenance, a stable
  workspace identity, and a curator decision.

## Identity

Every checkpoint and promoted memory binds:

- repository identity from the Git common directory;
- verified worktree root and branch/detached commit;
- run id and run directory;
- agent role plus stable Claude session id or Codex thread id when present;
- current Governess epoch;
- source journal path, byte/row cursor, and source SHA-256.

Worktree paths are locations, not repository identity. Reused PIDs, pane ids,
session titles, and model names are never identity keys.

## Heartbeat contract

- A bridge enqueue changes the authoritative bridge-journal version after the
  message row is durable.
- The bridge worker waits on a filesystem event, with a race-closing version
  check before sleeping.
- The worker persists each observed wake and each reconciliation outcome using
  atomic replace.
- Full reconciliation runs on startup and no later than five minutes after the
  previous persisted reconciliation, even when no event arrives.
- Duplicate, coalesced, or missing filesystem events are safe. Reconciliation
  is idempotent and derives pending work from the journals.
- Delivery acknowledgements retain their existing meaning. Notification and
  heartbeat rows never count as delivery.

## Checkpoint and promotion contract

A pre-compaction checkpoint is deterministic and file-first. It records active
objective, verified workspace/commit, unresolved bridge messages, utility jobs,
claims/leases, decisions, blockers, exact evidence pointers, and the last
authoritative cursors. It excludes secrets, raw credentials, hidden reasoning,
and unrestricted transcript dumps.

Claude checkpoints run synchronously on its native `PreCompact` hook. Current
Codex hooks expose no stable pre-compaction event, so Codex writes the same
bounded checkpoint on `UserPromptSubmit`, before each new turn can consume or
compact prior context. A later transcript `compacted` record is observation,
not mislabeled as a pre-compaction trigger.

Promotion accepts only stable decisions, verified incident causes and fixes,
reusable runbooks, settled capability boundaries, and explicit user
preferences. It rejects transient progress, unreviewed model inference,
unresolved hypotheses, copied external instructions, and authority claims.
Promotion is an explicit file command that writes human-readable Markdown plus
a JSON provenance sidecar; retrieval indexes remain disposable derivatives.

## Honcho acceptance gate

Honcho is evaluated local-only and is not adopted by default. The bakeoff uses
the same frozen query set and source corpus for:

1. curated Markdown with exact grep/link retrieval;
2. Witchcraft/Pickbrain hybrid retrieval;
3. local-only Honcho, if its local deployment passes an egress-deny check.

Accepting Honcho requires materially better task-relevant recall or curation
quality without losing provenance, while staying within explicit latency,
resource, recovery, and operational-complexity budgets. A tie or ambiguous
result keeps Markdown plus Witchcraft.

## Out of scope

- Making Honcho, Pickbrain, Witchcraft, or an LLM a control-plane authority.
- Cloud Honcho APIs, telemetry, webhooks, Sentry, or remote embeddings.
- Giving utility helpers unbounded cross-session history.
- Restarting or modifying a healthy live loop during development.
