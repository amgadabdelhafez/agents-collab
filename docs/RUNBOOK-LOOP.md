# Loop cost reports

From a repository or one of its registered worktrees:

```bash
loop governess cost 38
loop governess cost 38 --json
```

The command reads the existing run manifest and session sources. It does not start or modify a run. Exit 0 means all reported components have prices and attribution; exit 1 means incomplete evidence or invalid input. An incomplete report still includes known components. `costUsd: null` means unknown, never zero. `knownSubtotalUsd` is explicitly partial and must not be treated as the run total.

Routed usage comes from `~/.config/loop/switchyard/routing.jsonl`, overridden by `LOOP_SWITCHYARD_ROUTING_LOG`. Only rows with `task` exactly equal to the Loop run ID are candidates. The report counts excluded unattributed and other-task rows over the whole log. No timestamp join is used. A same-number run under another local repository makes ownership ambiguous and refuses pricing. The header currently carries only a Loop run ID, so per-task reporting has that same granularity; utility-job breakdown is unavailable. The local collision check cannot prove the absence of foreign or deleted runs in an imported log.

Routed USD is derived from prompt/completion token totals times the current public OpenRouter per-token rates. Cache and reasoning counters are subsets, not additional tokens. These standard-rate estimates are not provider-reported invoices, do not reconstruct historic prices, and do not account for provider-specific cache discounts. Every model row shows rates and cache provenance. Local/unknown models have no invented zero rate.

The public models response is fetched without credentials, validated, then atomically cached at `~/.cache/loop/openrouter-models.json` for 24 hours. Fetches emit a bounded timing/status span on stderr. `LOOP_OPENROUTER_PRICE_CACHE` supplies an offline raw models response; missing, stale, future-dated, malformed or incomplete offline evidence is rejected without network fallback. Failed default refresh never falls back to stale data.

Claude and Codex retain `readAgentUsage` and the existing usage-tracker pricing path and environment settings. Reports label transcript tokens, bundled API-equivalent estimates, or usage-tracker credit estimates separately. Missing transcripts or price coverage produce unknown amounts. Existing session-reader limitations (including current-session fallback and model aggregation) remain; these estimates are not subscription invoices.

For a run predating the intake header, routed and full run cost are unknown because the unowned rows cannot establish either task ownership or zero spend. Available subscription components remain visible in the known subtotal. Loop's Pi `usage.jsonl` routed zero costs are not consumed or changed by this command.

Rate schema: [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Prior derivation/cache design: harness-engineering `origin/main:.harness/kit/scripts/budget_routing.py` (read-only reference).
