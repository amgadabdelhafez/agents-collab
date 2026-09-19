# Acceptance checks

- derivation-known-usd: known counters/rates yield known USD without double-counting subsets.
- unknown-model-closed: names the unknown model, leaves total unknown.
- unattributed-excluded: excludes/counts legacy rows; pre-header run total is null.
- subscription-source-preserved: actual transcript plus existing pricing yields nonzero expected estimate independent of routed evidence.
- price-cache-closed: 24h freshness, invalid/missing/duplicate pricing and invalid counters fail closed.
- cli-cost-sources: text and JSON expose task/run scope and every cost/token/count source.
- mutation: change the derivation; named check must fail; restore and pass. Paste both outputs.
- real-run: execute source CLI against a machine run directory; paste all output and label unknowns.
- certification: bun run check; typecheck; each touched test under LOOP_TEST_CERTIFICATION_MODE=single-file; bun run test:ci, independently count 116 completed files and zero failures.
- whitespace: git diff --numstat equals git diff --numstat --ignore-all-space; git diff --check passes.
- independent review and passing runs/gov-3-cost-from-routing-log/eval.json before PR.

No rendered UI change, screenshots inapplicable. scripts/verify.sh includes a forbidden build; execute non-build gates separately per charter.
