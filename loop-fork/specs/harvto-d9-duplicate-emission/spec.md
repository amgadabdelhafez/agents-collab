# D9 Idempotent Resolved Acknowledgement Emission

## Problem

At exact implementation base `18a590608b335f6a7637bf8215c4fe0508301282`, bridge
acknowledgements have no durable semantic replay identity. `bridge.ts` validates `send_message` and
passes its options through `dispatchBridgeMessage`; `bridge-store.ts` creates a fresh random message
ID, checks only the current pending set for the same source, target, and `dedupeKey`, optionally
supersedes that one pending row, and appends a new message plus transcript row. Delivery removes a
message from the pending set, so the same acknowledgement may be emitted again after delivery,
restart, or journal replay. Different predecessor dedupe keys also bypass pending-only dedupe even
when every other acknowledgement byte is the same.

The imported Run197 journal at
`/Users/amgad/.loop/runs/harvto-b1e274e66299/197/bridge.jsonl`, SHA-256
`a9d9defd30e40f9fec7f63f1c5f36d49845dac1b633e90b5622bbc46bbfb26fa`, contains the exact
D9 mechanism. Four predecessor records were resolved by four `type: "ack"` messages at
`2026-08-12T03:48:14.778Z` through `03:48:15.528Z`. The ack IDs and dedupe keys differ, but each
has source `codex`, target `supervisor`, subject
`RESOLVED: Loop-183 identity/predicate semantics; no ruling required`, identical normalized body,
and signature `2060bf71725d40df343cfb84573cc8dbd558c56962a71d9e9f0abdfc42068bb5`.
All four predecessor rows were superseded, all four ack rows were delivered, and transcript SHA-256
`b45102e24a40e168f5334bb094ffc029fc169f1efc0b7d778f28b9074426ab86` contains four effective
emissions of the same resolution.

## Required behavior

1. An explicitly typed bridge acknowledgement has one semantic identity across enqueue retries,
   process restart, delivery, and append-only journal replay. The identity is the tuple of:
   `type: "ack"`; the bridge signature recomputed by existing reconstruction logic (which binds
   source, target, and normalized body); subject; `replyTo`; `taskId`; `threadId`; and the exact
   ordered `artifactRefs` list. Missing optional values compare as missing. Random message ID,
   timestamp, priority, expiry/retention metadata, and `dedupeKey` are not acknowledgement
   identity.
2. Before appending an ack, enqueue searches all reconstructed message rows, not only pending rows,
   for that identity. The earliest matching valid ack in journal order is canonical, including
   when historical journals already contain duplicate ack rows. A match returns that canonical row
   with status `duplicate` and appends no second ack message, transcript entry, notification, or
   delivery attempt. A delivered or otherwise terminal canonical ack remains an idempotency fence
   after restart.
3. Supersession and acknowledgement emission remain distinct operations. When a repeated semantic
   ack carries `supersede: true` for a different still-pending predecessor dedupe key, that exact
   predecessor receives one `superseded` resolution before enqueue returns the canonical ack.
   When the pending same-key row is itself the canonical ack, replay returns it without
   superseding it. The Run197 four-key sequence therefore resolves all four predecessor rows but
   creates one ack message and one transcript emission.
4. Crash windows converge safely. A crash after predecessor supersession but before first ack
   append permits one later append. A crash after the ack append but before response, notification,
   consumption, or delivery permits no later append. A crash after superseding any later
   predecessor permits retry to rediscover the same canonical ack without another emission.
5. Identity is ack-specific and correlation-preserving. A changed source, target, normalized body,
   subject, `replyTo`, `taskId`, `threadId`, or ordered artifact list is a distinct acknowledgement.
   Repeated non-ack messages retain existing behavior, including multiple same-body messages with
   distinct IDs. D1 queue, liveness, expiry, retained-pressure, and ordinary dedupe/supersession
   behavior remains unchanged.
6. Journal compatibility is fail-closed and rewrite-free. Existing explicit `type: "ack"` message
   rows participate in the identity fence using fields already reconstructed by
   `readBridgeEvents`. Legacy rows with missing type continue to normalize as `message` and must not
   be silently promoted into acknowledgements. Missing optional metadata remains compatible;
   malformed lines retain current ignore behavior. D9 adds no journal event kind, migration,
   compaction, side index, or historical rewrite.
7. Delivery accounting remains by message ID. In the production enqueue/consume path, one accepted
   ack is offered once and receives the existing terminal delivery resolution; duplicate enqueue
   results do not create a second effective delivery. Existing inbox consumption continues to
   leave unrelated messages pending and ordered under current priority/time/ID rules. D9 does not
   redesign direct repeated `markBridgeMessage` calls outside that path.
8. The exact-base regression reproduces the Run197 shape through the real
   `enqueueBridgeMessage`/journal/transcript/pending/consume path: four pending predecessor keys,
   four calls with one identical resolved ack and `supersede: true`, journal reconstruction, one
   consume, and a post-delivery retry. Unchanged base must show four ack message rows, four
   transcript emissions, and four delivered ack IDs. A synthetic array deduper or fixture that
   bypasses append and reconstruction is invalid.
9. The bounded production scope is exactly `src/loop/bridge-store.ts`. The bounded regression
   scope is exactly `tests/loop/governess-p0-runtime.test.ts`. `src/loop/bridge.ts`,
   `src/loop/bridge-dispatch.ts`, `tests/loop/bridge.test.ts`, paired-loop completion tests, and D1,
   D4, and D5 suites are read-only controls. No general bridge redesign or cross-process journal
   locking is authorized unless the exact red disproves this serialized enqueue mechanism.
10. Every planning-byte change invalidates all five D9 contract SHA-256 values. Freeze all five
    together after planning edits stop, re-derive immediately before one fresh Claude full-file
    zero-write review at exact base `18a590608b335f6a7637bf8215c4fe0508301282`, and re-derive on
    verdict receipt. Only literal `PLAN PASS` naming that base and all five current hashes grants
    source/test/red authority. Two consecutive non-converging `REVISE` verdicts on the same premise
    stop and escalate.

## Compatibility and boundaries

- D9 does not reopen D8 or fix D10 guarded target/preimage evidence, D11 composer recovery, or D12
  socket discovery. D10-D12 remain parked for fresh successor runs.
- D5 paired completion keeps its exact structured completion identity. D4 peer decisions, utility
  result acknowledgements, and distinct task/thread/artifact correlations remain distinct.
- No Harvto mutation, live Run197 mutation, utility route, provider/model/dependency change, tmux
  injection, remote, merge, rebase, push, deploy, release, or root `.loop/` mutation is in scope.
  Run197 is read-only imported evidence.
- Utility and Au Pair remain exact `0/off/0`; no helper spend is authorized.
- No rendered UI changes. Screenshot and DOM capture are not required.
- Planning, Harness lifecycle, red evidence, evals, root ledgers, and handover records are
  bookkeeping scope and are excluded from the implementation commit.

## Acceptance

- The unchanged-base named regression faithfully produces four same-signature ack rows and four
  transcript/delivery emissions from one resolution body. If it does not, preserve honest
  `not-reproduced` evidence and stop without production edits.
- After the fix, the same four attempts resolve all four predecessors while returning one queued
  ack followed by three duplicate results that name the same canonical ID. Journal and transcript
  contain one ack emission; one consume creates one delivered resolution; restart/post-delivery
  retry creates nothing new.
- Same-key `supersede: true` replay cannot terminalize its own canonical ack. Distinct correlation
  identities emit independently; unrelated and legacy untyped messages retain existing behavior.
- Focused and mandatory gates pass. Task-local and repository-root evals are honest pass records
  with `baseline_failures: []` and empty by-name allowlists.
- One implementation commit containing only the exact production/test scope receives Claude
  literal zero-write `PASS` for its exact SHA. Harness then closes D9 exactly once and separate
  bookkeeping receives literal `BOOKKEEPING PASS` before Run89 hands over.
