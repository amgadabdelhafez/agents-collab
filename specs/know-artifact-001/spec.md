# Spec: KB artifact-reference read model

## Problem

The communication board now exposes safe content-addressed artifact references,
but the knowledge layer has no deterministic read model for discovering which
messages reference an artifact. Consumers would otherwise need to scan board
items themselves or risk copying message bodies and local paths into a second
store.

## Goal

Derive a strict, body-free KB artifact-reference index from one accepted
`SupervisorMessageBoardProjection`. Group each content-addressed reference by
artifact URI and expose only stable message/workflow backlinks and lifecycle
metadata.

## Non-goals

- Dereference, download, parse, summarize, promote, or mutate artifact content.
- Create knowledge claims, approval, sensitivity, taint, or provenance facts
  that are not present in an accepted ArtifactManifest.
- Accept local paths, arbitrary URLs, message bodies, transcripts, credentials,
  or engine-specific values.
- Add storage, HTTP, UI, deployment, or production infrastructure.

## Acceptance criteria

- [x] Input must be the exact `supervisor-message-board.v1` field shape and
      every nested board item must have its exact canonical field shape.
- [x] Only `artifact://sha256/<64 lowercase hex>` references are indexed.
      Missing, malformed, duplicate, local-path, and arbitrary-URL references
      fail closed.
- [x] Each artifact entry has deterministic, deduplicated backlinks containing
      only workflow/message/thread/from/to/phase/action/received-at metadata.
- [x] Artifact entries sort by artifact URI; backlinks sort by received time and
      stable workflow ID. Repeated projection produces byte-identical output.
- [x] The output contains no body, transcript, credential, local path, mutable
      artifact content, or engine-specific type.
- [x] The projector makes no workflow, bridge, board, artifact, or filesystem
      mutation and returned data cannot mutate its input.
- [x] Focused, full, static, build, and diff gates pass with empty named failure
      sets, followed by independent exact-SHA zero-write review.

## Exit condition

One exact committed candidate satisfies the criteria and receives literal PASS
from an independent zero-project-write reviewer.
