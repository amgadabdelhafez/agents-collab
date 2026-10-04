# Upstream gateway comparison, 2026-10-04

Current official docs retrieved through Context7 and primary repository pages.
No throughput/latency marketing claims were independently measured.

| Candidate | Relevant capability | Fit / limit |
|---|---|---|
| Bifrost | OpenAI-compatible gateway; explicit provider/model rules, fallbacks, virtual-key controls | First spike candidate. Apache-2.0 core; adaptive balancing, clustering and some controls are enterprise. Confirm feature availability in the exact pinned edition. |
| LiteLLM | Explicit aliases, budgets, ordered fallbacks and provider adapters | Baseline comparison. Do not enable budget-driven model downgrades without a declared fallback policy. Check exact edition/license for chosen controls. |
| Portkey OSS Gateway | TypeScript single/conditional/weighted/fallback routing | Alternative if JS integration reduces operations. Separate OSS gateway features from hosted virtual-key/governance examples. |

Sources:
- https://github.com/maximhq/bifrost
- https://github.com/maximhq/bifrost/blob/dev/docs/providers/routing-rules.mdx
- https://docs.litellm.ai/docs/routing
- https://docs.litellm.ai/docs/proxy/reliability
- https://github.com/Portkey-AI/gateway

Recommendation: disposable controlled-peer Bifrost versus LiteLLM spike, no paid
inference or credentials. Exact aliases nanny, au-pair, driver and reviewer map
to explicit approved models; no random cross-model routing. Test cancellation,
streaming/tool fidelity, 429 retry, provider failure, budget exhaustion, unknown
model refusal, body-free usage export and restart. Reuse gateway adapters,
retries and limits, then delete duplicate local provider logic only after parity.
Do not proxy subscription OAuth merely because a gateway speaks OpenAI format.

Initial SLA proposals, not measured service promises: Nanny 60 seconds, Au Pair
180 seconds, one supervised escalation on timeout. Distinguish queued, working,
completed, refused and failed. A helper timeout returns work to the driver, not
another hidden indefinite retry loop. Pricing continues to come from Tracker;
gateway usage metadata supplies requested/actual model, tokens and latency.

Pickbrain returned a dated Switchyard/PAIR proposal, not current selection or
activation authority. Index freshness remains unknown. Current source is the
authority for the existing proposal/apply boundary.
