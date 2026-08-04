# Exact replay release gate

Use this gate before claiming that a harness or routing change improves a fixed
replay corpus. It refuses comparisons whose execution identity changed or whose
gates were reviewed after measurement began.

## Artifacts

The command consumes three JSON files:

1. `registration.json` pins full baseline and candidate git SHAs, model,
   reasoning effort, prompt/tool/corpus SHA-256 values, the SHA-256 of the
   metrics extractor, every case ID and input hash, and all thresholds.
2. `review-stamp.json` records an independent `CONCUR`, the registration byte
   hash, and the commit SHA plus repository-relative path containing those
   exact bytes.
3. `observations.json` records raw per-case outcomes for both arms. It repeats
   all execution bindings so drift is detectable.

The reviewer must differ from `registeredBy`. The registration commit must
predate review, and review must predate measurement.

## Derived metrics

The gate derives these values instead of trusting submitted totals:

- success rate, new case failures, tokens, tool calls, and latency;
- reviewer CHANGES rounds before final approval, including the detector's
  upper bound;
- driver self-retractions and reviewer disproofs;
- correction-churn upper bound as CHANGES upper bound plus those retractions
  and disproofs.

The quality field names intentionally match `loop-metrics/extract.mjs`. Pin
that extractor's byte hash in `metricsExtractorSha256`; changing its
classification rules creates a different experiment.

## Command

Run from the repository containing the stamped registration commit:

```bash
loop release-gate verify \
  path/to/registration.json \
  path/to/review-stamp.json \
  path/to/observations.json
```

The command prints a JSON result. `ok` is true only when every binding,
chronology check, case identity, and preregistered gate passes. Any failure
sets a nonzero exit code and is listed in `failures`.
