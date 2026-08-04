# Honcho local-only memory bakeoff

## Decision

Reject Honcho for the loop harness. Keep curated Markdown as the authoritative,
human-readable memory layer and Pickbrain/Witchcraft as its rebuildable semantic
retrieval projection.

The decision follows the preregistered conjunctive gate in
`evals/memory-bakeoff/thresholds.json`. Honcho failed retrieval quality and
operator-complexity gates; passing operational measurements cannot compensate
for either failure.

## Frozen result

| Measure | Markdown | Pickbrain/Witchcraft | Honcho |
|---|---:|---:|---:|
| Recall@5 | 10/12, 83.3% | 12/12, 100% | 5/12, 41.7% |
| Provenance accuracy | 100% | corpus identity embedded in result | 100% |
| Warm p50 | under 1 ms except first query | 110-124 ms/query | 25.0 ms |
| Warm p95 | 7.6 ms | 123.5 ms | 27.9 ms |

Honcho operational evidence:

- direct public HTTPS from the API container failed DNS on an internal Docker
  network;
- API model traffic could reach only two fixed-destination relays to the local
  XTR and MLX ports;
- all six Honcho-side services used 620.0 MiB and 1.95% CPU after a 15-second
  quiescence period, excluding the already-running local model servers;
- API restart to a positively checked `/health` response took 10.48 seconds;
- standing the candidate up required nine distinct operator steps versus the
  preregistered maximum of six.

## Interpretation

Honcho is technically viable as a self-hosted service, but it does not improve
this harness's bounded curated-memory use case. Its strongest properties here
were fast vector lookup, preserved metadata, and clean recovery. Those do not
offset worse task recall than both simpler candidates and the additional
Postgres, Redis, API, deriver, tokenizer-cache, network-isolation, and relay
operations.

The retrieval comparison also surfaced an adapter mismatch worth retaining as
evidence: Honcho's pgvector path accepts one vector per message, so the local
adapter used a normalized mean-pooled XTR vector. Pickbrain used Witchcraft's
native XTR retrieval. Adopting Honcho would therefore require another embedding
model or a custom multivector integration before it could claim parity. That is
additional work, not a reason to relax this gate.

## Privacy proof

No user transcript, repository memory, tool output, or live-loop journal was
ingested. The corpus is synthetic and committed in
`evals/memory-bakeoff/fixture.json`. Telemetry, Sentry, webhooks, and hosted
providers were disabled. The two public tokenizer blobs were downloaded before
runtime, verified against the hashes required by the installed tiktoken code,
and mounted read-only. Runtime direct egress remained denied.

## Revisit conditions

Reopen this decision only if a later Honcho release provides a materially
simpler local profile or a native retrieval path compatible with the local
multivector model. Any revisit must use a new frozen fixture and thresholds,
not tune against this result.
