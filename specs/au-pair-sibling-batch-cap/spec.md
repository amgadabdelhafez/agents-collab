# Au Pair sibling batch capacity

## Problem

Loop 122 recorded an Au Pair audit failure because a 15-call sibling tool batch exceeded the default limit of 12. The independent total tool-call ceiling is 32, so the default rejected a bounded audit well before the overall safety budget.

## Requirement

- Permit up to 16 sibling tool calls by default.
- Preserve `LOOP_UTILITY_MAX_SIBLING_TOOL_CALLS` as an explicit bounded override.
- Preserve the 32-call default total ceiling and the fail-closed oversized-batch behavior.
- Do not mutate a live loop.

## Acceptance

- A producer-backed Pi test completes a 15-call Au Pair batch under defaults and records all 15 broker events.
- The existing explicit limit of 12 still rejects a 13-call batch before broker execution.
- Focused tests, full certified tests, lint, build, and diff checks pass.
