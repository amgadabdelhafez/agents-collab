# Spec: durable supervisor artifact references

## Problem

`COMM-BOARD-001` durably stores content-addressed references inside supervisor
thread events, but there is no exact named durable artifact-reference view.
The earlier KB prototype reads an in-memory board and therefore does not prove
that references survive thread-store restart or lifecycle updates.

## Goal

Project artifact references only from a fresh authoritative read of
`JsonlSupervisorThreadStore`. Group each content-addressed artifact URI with
stable, body-free thread/message/workflow backlinks including the immutable
message category.

## Non-goals

- Add another journal, copy artifact content, or dereference artifacts.
- Infer manifest, sensitivity, taint, provenance, approval, or knowledge facts.
- Store body, transcript, credential, local path, or engine-specific data.
- Add HTTP, UI, deployment, or external infrastructure.

## Acceptance criteria

- [x] The artifact view can be produced only through a fresh read of the exact
      durable thread-store class; malformed journal bytes fail before projection.
- [x] Only the store-validated content-addressed artifact URIs are grouped.
- [x] Lifecycle updates replace the prior workflow state and cannot duplicate an
      artifact backlink or change immutable references.
- [x] Backlinks contain only workflow/message/thread/from/to/received-at,
      current phase/action, and immutable message category.
- [x] Artifacts sort by URI; backlinks sort by received time and workflow ID;
      restart and repeated reads are byte-identical.
- [x] Output is defensive and contains no body, transcript, credential, local
      path, artifact content, manifest claim, or engine-specific type.
- [x] Focused/full/static/build/diff gates pass and an independent exact-SHA
      zero-write reviewer returns PASS.

## Exit condition

One exact committed candidate satisfies every criterion and receives literal
PASS from an independent zero-project-write reviewer.
