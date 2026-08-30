# Spec: Loop orchestration integration

## Goal

Make the reviewed Temporal supervisor-message and task-graph runtimes an
owned Loop service instead of test-only libraries. Current supervisors must be
able to route, claim, acknowledge, retry, escalate, and inspect messages without
the founder relaying them, while Harness work is admitted only when its declared
dependency graph says it is ready.

## Requirements

1. A run-owned orchestration service composes the existing Temporal runtime,
   bridge delivery adapter, authenticated control surface, durable thread store,
   and task-graph runtime. It refuses startup when routes, identity, authority,
   Temporal connection, or state paths are ambiguous.
2. Trusted supervisor routes are derived from exact Loop manifests and declared
   bridge topology. Delivery targets the manifest-declared driver, never the
   reviewer or an unconsumed external-supervisor inbox. A message can never
   supply a run directory, socket, pane, or bridge target.
3. Supervisor operations are deny-by-default and every decision emits the
   existing body-free governance receipt.
4. Harness graph input is explicit and canonical. Nodes declare dependencies,
   repository owner, read/write scopes, authority gates, acceptance checks, and
   a content-addressed spec. Invalid, missing, cyclic, or incomplete dependency
   data refuses before any task is claimable.
5. The service exposes health plus the existing authenticated message, board,
   Attention, knowledge, and task-graph endpoints. No credential is persisted,
   logged, placed in argv, or returned by health.
6. A focused integration proves one supervisor-to-supervisor delivery through a
   real run bridge. App-server acceptance is not consumption: the driver must
   pull the exact durable body with `receive_messages` before the workflow may
   claim and acknowledge it. The same proof includes a two-node Harness DAG
   whose dependent node cannot be claimed early.

## Non-goals

- Rebuild Temporal, the bridge, Governess, or Harness task execution.
- Type into agent composers or preserve the legacy `sup-courier` behavior.
- Restart, kill, or mutate existing product Loops during implementation.
- Merge, push, or deploy production infrastructure.
