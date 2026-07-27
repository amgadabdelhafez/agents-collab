# Plan

1. Pin Pi and prove its public SDK builds in source and compiled Bun modes.
2. Add a provider-generic ephemeral Pi runtime with in-memory credentials,
   empty resources, no built-in tools, timeout/abort handling, and normalized
   text/usage/lifecycle results.
3. Define pure utility execution classification and persist one of
   `utility-direct`, `utility-nanny`, or `utility-au-pair` on every utility route.
4. Split local and GLM configuration/capacity, preserving pending ownership
   when a selected tier is full or unavailable.
5. Add a direct broker executor for exact structured work and a Pi tool-agent
   adapter for reasoning work. Keep the existing broker as enforcement and the
   legacy conversation backend as explicit rollback only.
6. Move production governess local completions to the shared Pi runtime while
   retaining injected HTTP behavior for existing deterministic unit tests.
7. Add tier, harness, provider/model, Pi lifecycle, usage, and capacity
   observability; add separate filtered Nanny and Au Pair panes; update
   operator terminology, help, and architecture/dependency docs.
8. Run focused tests, live local canaries, the full suite/build/verify path,
   confirm Loop 55 is untouched, and obtain independent evaluation.
