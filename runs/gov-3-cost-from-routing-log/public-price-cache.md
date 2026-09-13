# Public price cache proof

Source invocation: `bun -e` imported parseRoutingUsage and priceRoutingUsage from src/loop/routing-cost.ts, supplied an explicitly synthetic task price-cache-proof with model openai/gpt-4, 1000 prompt tokens and 200 completion tokens. This verifies public fetch/derivation, not spending by a real run.

Observed stderr span and stdout on first fetch:

```text
{"durationMs":237,"kind":"governess-cost-price-fetch","ok":true,"startedAt":1789264401060,"url":"https://openrouter.ai/api/v1/models"}
```

```json
{"costUsd":0.042,"models":[{"completionTokens":200,"model":"openai/gpt-4","promptTokens":1000,"rows":1,"completionRate":0.00006,"costUsd":0.042,"promptRate":0.00003}],"priceCache":{"fetchedAt":"2026-09-13T01:53:21.299Z","path":"/Users/amgad/.cache/loop/openrouter-models.json","url":"https://openrouter.ai/api/v1/models"}}
```

The raw public models response was cached by the production reader without credentials. Existing offline-cache tests separately prove stale/future/missing/unknown failure paths.
