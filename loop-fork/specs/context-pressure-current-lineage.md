# context-pressure-current-lineage

Task active, mode review. The earlier `25bb5e8` review candidate was withdrawn
before review and is retained only as historical evidence.

## Scope

Restack the reviewed context-pressure handoff on exact supervisor-concurred
source `c842fac`, preserve every newer handover guard, add combined-lineage and
asymmetric effort-carry regression coverage, and stop at exact-SHA supervisor
review.

## Result

- Restacked reviewed feature `14687ce` onto exact concurred source `c842fac`.
- Retained the newer transaction-epoch resolver alongside pressure activation.
- Added a mutation-proven regression for pressure-triggered epoch persistence.
- Added a non-default `driverEffort=high` producer fixture that kills the
  hardcoded-medium mutation found during review of slice 1.
- Passed focused tests, static checks, compiled build, the complete sequential
  suite, and `scripts/verify.sh` with an empty baseline-failure list.
