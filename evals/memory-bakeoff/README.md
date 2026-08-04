# Local memory bakeoff

This fixture compares three rebuildable retrieval projections over the same
synthetic, non-secret curated-memory corpus:

1. plain Markdown lexical retrieval;
2. Pickbrain/Witchcraft hybrid retrieval through isolated Pi session fixtures;
3. Honcho 3.0.11 at upstream commit `148f646`, with Postgres/pgvector and Redis.

`thresholds.json` is the preregistration. Run it only after Honcho is isolated
on an internal Docker network, telemetry is disabled, and its embedding and
deriver model URLs point at local services. `run.mjs` deliberately probes a
public HTTPS URL from the API container and accepts only a failed connection as
egress-deny evidence.

The bakeoff is an adoption gate, not a release gate. Its corpus is synthetic;
no user transcript, repository memory, or tool output is sent to Honcho. A
rejection leaves curated Markdown plus Pickbrain/Witchcraft as the production
design.

The local embedding adapter emits one normalized, mean-pooled XTR vector per
message because Honcho's pgvector path accepts one vector. Pickbrain exercises
Witchcraft's native XTR retrieval. The report records this constraint rather
than treating the two adapters as identical.
