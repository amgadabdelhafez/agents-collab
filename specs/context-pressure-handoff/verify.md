# Verification

- GPT-5.6 at 138,750 context tokens prepares; at 185,000 it hands off.
- GPT-5.6 at 14 turns prepares and at 18 turns hands off when context is absent.
- GPT-5.5 below its profile does not inherit GPT-5.6's turn threshold.
- One compaction outranks lower context/turn values; two compactions produce the
  hard-ceiling phase.
- Context reason outranks a simultaneous turn crossing.
- Unknown context never fabricates a pressure percentage.
- Persisted state round-trips and an unchanged phase emits no duplicate message.
- Observe/off/dry-run modes never activate the exit lifecycle.
- Enforce mode activates exactly one existing handover and never injects
  `/compact` or kills an agent directly.
- Focused tests, `bun run check`, production build, complete sequential suite,
  Harness preflight, and Harness stop-gate pass.
