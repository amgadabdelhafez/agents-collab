# Task webui-t01-read-model-v2

Created: 2026-08-25T23:05:48Z
Mode: planned
Description: Implement Web UI T-01 canonical side-effect-free fleet, run, and timeline read model.

## What I changed

- Added a capability-typed, read-only control-surface model for canonical fleet
  and run projections from manifest, transcript, hooks, Governess, bridge,
  utility, usage, and adapter evidence.
- Added exact-byte source snapshots, strict UTF-8/JSON parsing, versioned
  freshness and aggregate-status semantics, one-retry epoch consistency, and
  explicit bounded instability/conflict results.
- Bound storage, repository, run, directory, and file identities across reads
  to reject symlink, replacement, and concurrent mutation escapes.
- Added strict producer/public schemas, path/URL/credential redaction, escaped
  deterministic timeline paging, and opaque evidence references.
- Added focused malformed, legacy, freshness-boundary, conflict, redaction,
  containment, and source-race tests.

## Why

The Web control surface needs one canonical read model that reflects durable
Loop evidence without acquiring process, tmux, maintenance, messaging, or
mutation authority. Unknown or changing evidence must remain explicit rather
than being guessed healthy or mixed across source epochs.

## Notes

- Exact implementation SHA `b3c33fcbf5fb415431e668e20ab2d2744ffee56e`
  received an independent zero-write PASS with no blocking findings.
- Final focused suite, full regression, compiled build, scoped static check,
  diff check, Harness preflight, and stop-gate pass with an empty named
  baseline.
- T-02 server/authentication/SSE and all Web mutation authority remain outside
  this task.
