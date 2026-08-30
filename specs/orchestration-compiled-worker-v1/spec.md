# Spec: compiled orchestration worker

## Goal

Make the standalone compiled Loop binary start its embedded Temporal workflow
worker without relying on `TEMPORAL_DEBUG`, a source checkout, or a build-time
`node_modules` path.

## Requirements

1. The compiled orchestration server selects Temporal's supported in-process
   reusable-VM workflow execution mode explicitly. General source-host callers
   remain threaded unless they opt in.
2. The embedded workflow bundle remains the only workflow source. No runtime
   dependency path, credential, or debug environment variable is introduced.
3. A compiled-binary smoke proof starts the server with `TEMPORAL_DEBUG` absent,
   reaches ready health, and shuts down without mutating product repositories.

## Non-goals

- Change workflow semantics, routing, authority, task DAGs, or projections.
- Install a binary or restart any live Loop.
