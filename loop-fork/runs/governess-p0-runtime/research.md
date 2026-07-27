# Governess P0 Reuse Research

## Research Question

Which established orchestration and durability patterns should this paired-loop
runtime reuse without importing a larger distributed framework?

## Candidates Reviewed

- Overstory: typed SQLite mail and tiered watchdogs.
- Gas Town: persistent identities, work convoys, escalation, and telemetry.
- A2A: typed tasks, messages, artifacts, context, and lifecycle.
- LangGraph: checkpoints, interrupts, replay, and worker leases.
- OpenHands: action/observation separation and risk confirmation.

## Open-Source Patterns

- Typed work envelopes replace prose as protocol.
- Indexed current state is backed by append-only history and retention.
- Bounded queues use priority, expiry, dedupe, and dead-letter outcomes.
- Mechanical failure injection validates idempotency and fencing.

## Reuse Decision

Adapt the patterns using the repository's existing JSONL stores and pure decision
boundaries. Add a versioned sidecar hot index instead of a database dependency,
preserving portable audit logs and compiled-binary simplicity.

## Sources

- https://github.com/jayminwest/overstory
- https://github.com/gastownhall/gastown
- https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- https://langchain-ai.github.io/langgraph/concepts/breakpoints/
- https://docs.openhands.dev/sdk/guides/security
