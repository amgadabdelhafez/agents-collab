# governess-native-runtime Research

## Research Question

Which established orchestration patterns improve reliable two-agent supervision
without introducing a second scheduler or sacrificing terminal compatibility?

## Candidates Reviewed

- Overstory: durable agent/mail state, explicit lifecycle, watchdog separation,
  and recovery-oriented orchestration. Its architecture is useful; adopting its
  whole runtime would duplicate loop's existing scheduler and bridge.
- Gas Town: role-based coordination, handoff continuity, and work ledgers. The
  semantic handover pattern fits, but its issue/convoy model is broader than a
  paired local loop.
- A2A protocol: typed task states, artifacts, and explicit status updates. Its
  lifecycle vocabulary and correlated message IDs fit; a network protocol does
  not add value inside one local process tree.
- OpenHands: event-stream action/observation separation and replayable state.
  The split is directly applicable to governess ticks.
- LangGraph: checkpointed state transitions and interrupt/resume semantics. The
  concepts fit, but adding the framework would expand dependencies and obscure
  existing TypeScript control flow.

## Open-Source Patterns

- Persist intent before effects, then append receipts rather than mutating away
  history.
- Use correlation IDs, epochs/leases, and monotonic state transitions to make
  restart behavior deterministic.
- Treat lifecycle events as provider-authored evidence, not terminal prose.
- Split observation, decision, and execution so policy can be replayed without
  repeating effects.
- Perform handover as a prepare/accept protocol bound to a manifest digest.
- Prefer native event/message APIs; retain terminal control only as a guarded
  compatibility adapter.

## Reuse Decision

Adapt the patterns to existing modules. Reuse `bridge-runtime`, Codex app-server,
Claude/Codex hooks, epoch leases, authorization policy, and the append-only JSONL
journal. Add small normalization, reconciliation, decision, and acceptance
modules. Do not add an orchestration framework, SQLite, or an OpenTelemetry SDK
in this slice: the current single-writer JSONL model already provides atomic
append/replay, and structured trace records can later feed an exporter.

## Sources

- https://github.com/jayminwest/overstory
- https://github.com/gastownhall/gastown
- https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto
- https://github.com/OpenHands/docs/blob/main/llms.txt
- https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py
