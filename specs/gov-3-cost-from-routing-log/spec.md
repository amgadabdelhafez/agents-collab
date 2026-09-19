# Governess cost from routing tokens

Add `loop governess cost <runId> [--json]`, a read-only report for the current repository's run. Route rows have no USD field. Match only the explicit `task` header equal to the Loop run ID; utility-job breakdown is unavailable at that granularity. Never infer ownership from timestamps. Exclude and count unattributed and other-task rows. Refuse ambiguous cross-repository run IDs. Preserve subscription pricing tables and usage-tracker reader.

Derive routed USD as prompt_tokens * OpenRouter pricing.prompt + completion_tokens * pricing.completion, with named model rates and a cached public models response no older than 24 hours. Cache/reasoning counters are subsets and are not added again. This is a current public standard-rate derivation, not provider-reported billed USD or historical pricing. Unknown models, invalid counters/prices, stale offline cache, malformed or missing logs fail closed with reasons. No local-model zero-price guesses.

Report per-task (Loop run ID) and per-run cost, source-labelled seat components, known partial subtotal, and null total when evidence is incomplete. Runs predating the intake header have unknown routed/total cost, with unattributed rows excluded and counted, never zero. Missing subscription transcripts or price coverage are unknown. Existing Claude/Codex readAgentUsage and usage-tracker pricing remain the subscription source, with estimates labelled by basis.

No Pi model registration changes; its usage.jsonl zero costs are not consumed here. No Switchyard changes, routing changes, restarts, binary builds/installs, or edits in harness-engineering. CLI output is the only UI surface.
