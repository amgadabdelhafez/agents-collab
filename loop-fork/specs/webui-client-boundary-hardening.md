# webui-client-boundary-hardening

Task completed 2026-08-22T19:25:12Z, mode maintenance.

## What was built

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

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-08-22T18:40:19Z)
