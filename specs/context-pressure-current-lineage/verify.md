# Verification

- The branch descends from exact concurred source `c842fac`.
- Pressure thresholds and compaction precedence focused tests pass.
- A pressure-triggered handover pins the current transaction epoch, persists
  it, refuses to start a second lifecycle after restart, and retains the old
  handover epoch under a newer Governess fencing epoch.
- Existing handover restart, composer, trailing-stop, journal, and bundle tests
  remain green in the complete sequential suite.
- An asymmetric `driverEffort=high`, `reviewerEffort=low` fixture proves the
  exact frozen values reach the manifest and replacement argv; hardcoding the
  driver effort to `medium` must fail the named tests.
- `bun run check`, the targeted TypeScript check, `bun run build`,
  `bun run test:ci`, and `scripts/verify.sh` pass with an empty baseline failure
  list.
- No installed binary or live loop is changed.
