# Spec: operational Temporal orchestration proof

## Goal

Bind the reviewed authenticated orchestration control surface to the real
Temporal runtime host and prove a cross-supervisor message plus a dependent task
graph can complete without a human relay.

## Requirements

1. The real Temporal host exposes one Fetch-compatible handler composed from its
   canonical SupervisorMessage and task-graph runtimes.
2. Authentication remains an injected port. The host does not invent, persist,
   or log credentials.
3. One staged Harvto-to-Harness message is delivered automatically, claimed by
   Harness, acknowledged, and projected into the durable thread board,
   Attention, and knowledge artifact views.
4. One two-node graph refuses the dependent node until its predecessor has the
   exact acceptance receipts, then completes both nodes through authenticated
   worker identities.
5. The proof runs on Temporal's real local test server and uses no manual relay,
   production deployment, downstream repository mutation, or external secret.

