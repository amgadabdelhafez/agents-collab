# System Overview
> High-level architecture. Keep this current. Agents use this to understand system boundaries.

## System map

_(Describe services, their responsibilities, and how they communicate.)_

```
[client] → [api-gateway] → [service-a]
                         → [service-b] → [service-c]
                                       → [data-store]
```

## Service responsibilities

| Service | Owns | Does NOT own |
|---|---|---|
| [service-a] | [domain] | [explicitly excluded] |
| [service-b] | [domain] | [explicitly excluded] |

## Bounded contexts

_(List the major bounded contexts and their interfaces. Agents must not cross these without a spec.)_

## Architecture invariants

See `specs/constitution.md` for the enforced list. Quick reference:

- Services communicate only through declared interfaces (no direct DB sharing across contexts).
- All external I/O emits a trace span.
- Credentials are never accessed directly by agents; routed through the secrets proxy.

## Key data flows

1. **[Flow name]:** [Step-by-step description]
2. **[Flow name]:** [Step-by-step description]

## Runbooks

- How to boot the full stack locally: `docs/testing/commands.md`
- How to inspect a worktree's observability: `scripts/collect-o11y.sh --help`
