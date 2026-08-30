# Spec: durable supervisor threads

## Problem

The current communication board is an in-memory projection. It disappears with
the process and has no durable thread identity, event idempotency, or immutable
message category. It therefore cannot serve as `COMM-BOARD-001` or as the
source for the category-selective Attention projection.

## Goal

Persist validated supervisor-board items in one append-only, fsync-backed
thread journal. Each event binds an idempotency key, canonical observation time,
stable workflow item, and immutable message category. A new store instance must
rebuild the same deterministic thread projection from the journal.

## Non-goals

- Store message bodies, transcripts, credentials, local paths, or artifact
  content.
- Replace workflow, bridge, claim, or governance authority.
- Add HTTP, UI, deployment, or external infrastructure.
- Infer message category from prose.

## Acceptance criteria

- [x] The store accepts only exact canonical board items and one category from
      `question`, `conflict`, `failure`, `authority-decision`, or
      `informational`.
- [x] Each append is one bounded JSONL record written through an owned file
      descriptor and fsynced before success is returned.
- [x] Event IDs are idempotent. Exact replay returns replayed; same ID with
      different content fails closed and appends nothing.
- [x] A workflow may update lifecycle state, but its category, message, thread,
      source, destination, received time, and artifact references are immutable.
- [x] Missing journal means an empty board. Malformed, truncated, extra-field,
      or internally conflicting journal data fails closed rather than skipping.
- [x] A fresh store instance rebuilds byte-identical threads, participants,
      message order, latest workflow states, updated times, and revision.
- [x] Public thread projections contain no body, transcript, credential, local
      path, artifact content, or engine-specific types.
- [ ] Focused/full/static/build/diff gates pass and an independent exact-SHA
      zero-write reviewer returns PASS.

## Exit condition

One exact committed candidate satisfies every criterion and receives literal
PASS from an independent zero-project-write reviewer.
