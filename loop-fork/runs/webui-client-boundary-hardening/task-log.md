# Task webui-client-boundary-hardening

Created: 2026-08-22T18:40:19Z
Mode: maintenance
Description: Fail closed on unknown DTO fields, exact read-only policy literals, ISO timestamps, bounded counters, and evidence identifiers before PR merge.

## What I changed

- Added exact required/optional own-key allowlists for every one of the 26 fixed
  public DTO object shapes. The route-keyed `details` map remains dynamic and
  must still match the fleet route set exactly.
- Replaced permissive date parsing with exact `Date.toISOString()` grammar and
  semantic round-trip validation, including canonical expanded years.
- Enforced the server's `ev_` plus 16 lowercase hexadecimal evidence grammar,
  the literal `Read-only release` policy label, nonnegative safe-integer
  counters, bounded percentages/confidence, and finite nonnegative costs.
- Expanded the complete contract fixture so audit, interpretation, policy,
  bridge, optional-usage, evidence, worker, and timeline validators cannot pass
  vacuously.
- Added a negative matrix covering all shapes, all timestamp consumers, all
  evidence-reference consumers, every numeric consumer, optional-field omission,
  exact literals, source markers, and fetch-level fail-closed behavior.
- Removed coercive enum membership checks and added one-element-array rejection
  cases for all nine affected literal-union consumers.
- Bounded persisted hook/compaction counters and saturated per-run/fleet sequence
  sums so the producer always stays inside the client safe-integer contract.

## Why

The prior structural validator rejected malformed required values but accepted
unknown fields and several invalid scalar forms. That widened the browser-facing
read-only boundary beyond the declared DTO contract and could admit hidden raw
fields even when matching fleet/detail summaries contained the same extra data.

## Notes

- Harness unit attempt 001 is the preserved pre-production RED result. It records
  the permissive validator accepting the newly prohibited payloads.
- Focused GREEN: 72 tests, 209 assertions, zero failures.
- Server producer compatibility: 32 tests, 187 assertions, zero failures, plus
  the current live Harvto lane accepted by the hardened validator.
- Live security scan: zero leaked persisted values, zero absolute paths, and zero
  raw runtime fields.
- Full sequential regression passed 1,646 tests across all 80 discovered files.
- Web build, targeted formatter/lint checks, and diff whitespace checks pass.
- The repository-wide formatter command reports generated Harness JSON
  formatting diagnostics, including immutable prior-run artifacts; the four
  changed code/test files pass the same formatter with zero diagnostics.
- Exact review candidate `c7da4ea` received literal FAIL. Reviewers found the
  regression-count undercount, one-element-array coercion at nine enum fields,
  and a full-diff whitespace mismatch in the preserved RED log. The branch was
  not pushed and the PR remained draft. `review-attempt-001.md` preserves the
  exact failed-review record and the original RED-log hash.
- Exact review candidate `3053e13` was superseded after one PASS and one FAIL:
  the negative cost matrix did not explicitly prove that zero remains valid at
  both optional cost consumers. `review-attempt-002.md` preserves that verdict.
- Exact review candidate `84bf07a` was superseded after one PASS and one FAIL:
  the outward task record contained a wrapped `the two four` typo.
  `review-attempt-003.md` preserves that verdict.
