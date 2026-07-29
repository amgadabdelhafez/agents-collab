# Regression Eval: terminal-payload-size-coupling

Generated: 2026-07-29T18:17:40Z
Source task: `constant-size-transport`
Status: executable

## Failure Symptom

- Realistic launch charters and bridge bodies could block or silently fail when transported through terminal paste and tmux readiness paths.

## Guard Evidence

- `bash ../evals/smoke/constant-size-transport.sh`

## Verification Artifacts

- `smoke`: `runs/constant-size-transport/artifacts/smoke/verify.log` (pass)
- `unit`: `runs/constant-size-transport/artifacts/unit/verify.log` (pass)

## Source Task Notes

- Exact-SHA CONCUR `c6e8ba46-6155-4532-8d74-2dc7689014a1` binds commit
  `3542760d26608fdf5574405a9e9779a1ad727de9` after independent execution of
  both committed guards and all 1,214 tests.
- Binary SHA-256
  `66daf24713dc3e5e8e08387b3bd8202772be5d988e092ee7df5bc52ffec016f9`
  was deployed and passed the joint live-launch gate for Harvto run 100.

Regression: yes
Regression id: terminal-payload-size-coupling
Regression symptom: Realistic launch charters and bridge bodies could block or silently fail when transported through terminal paste and tmux readiness paths.
Regression guard: `bash ../evals/smoke/constant-size-transport.sh`

## Next Step

Keep the executable guard in the Harness smoke dimension for future transport
changes.
