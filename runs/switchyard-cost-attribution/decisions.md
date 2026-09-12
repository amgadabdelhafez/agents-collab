# Decisions

## Task identity

Use Loop run ID, derived from `basename(runDir)`. No harness task ID is in scope at Pi
provider construction, and the charter requires Loop run ID as fallback. Utility `jobId`
was rejected in peer review because it is not one of the allowed task-header identities.

## Header mechanism

Use pi-ai `Model.headers`. The gateway test proves Pi forwards this model field on the
actual HTTP request. Direct OpenRouter retains its catalog model and receives no
Loop-specific header.

## Endpoint boundary

Send only for Au Pair endpoints whose host is `localhost`, `127.0.0.1`, `::1`, or
`[::1]` across URL implementations.
Nanny and direct OpenRouter requests remain unchanged.

## Cost values

Do not assign a static Au Pair rate. Switchyard can route to different models, and no
authoritative non-interactive rate source was established for one safe model-level value.
The separate ingest half derives cost from logged model and token fields.

## Timestamp-only attribution

No. Concurrent or overlapping routed calls can share a timestamp window, while existing
routing rows have empty task, trial, session, and tier identifiers. A timestamp window is
correlation evidence, not reliable per-task attribution.
