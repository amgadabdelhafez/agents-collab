# Task d026-producer-tmux-manifest-fixture

## Objective

Produce deterministic new and legacy manifest fixtures from compiled candidate
output with independently verified provenance and hashes.

Regression: yes
Regression id: hand-authored-manifest-compatibility
Regression symptom: Compatibility evidence does not prove the producer persisted socket identity.
Regression guard: fixture index hash and derivation verification

## Verification

- The capture script compiles the current candidate and executes it under a
  closed environment with an isolated fake tmux and current OSS/Claude tool
  stubs. No real tmux command is reachable.
- Fake tmux records an argv ledger and accepts only the singleton version probe
  or the exact requested socket. Capture requires exactly version, prelaunch
  liveness, failing new-session, and cleanup liveness in that order.
- Every `-t`/`-s` value equals the nonempty session persisted by the producer.
- The normalized trace replaces logical and canonical scratch paths plus
  volatile Claude, repository, and World Model identifiers.
- The new manifest is producer-derived. The legacy file is byte-derived by
  removing only `tmuxSocket`.
- The index records candidate SHA, source commit, producer version, UTC time,
  capture argv/environment/exit, raw manifest/stderr/argv hashes, normalizer
  hash, and all three artifact hashes.
- Clean and hostile ambient recaptures produced identical hashes:
  `manifest-new` `4a629c…`, `manifest-legacy` `946cc1…`, trace `07a179…`.
- Focused tests: 3 passed, 0 failed, 24 assertions.
- Exact static analysis and diff check passed.
- Independent zero-write review: PASS.
