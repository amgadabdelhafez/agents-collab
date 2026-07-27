# Governess Usage Display Stability Log

- Reproduced live run 50 changing `W8 · 6d16h` to `S8 · —` on tracker misses.
- Direct `/stats` probe: 11 full HTTP 200 responses and one two-second timeout.
- Implemented bounded per-provider quota retention for transient or partial
  snapshots while preserving current pricing.
- Focused tests: 70 pass, 0 fail.
- Full tests: 830 pass, 4 unchanged environment-sensitive baseline failures.
- Build and repository placeholder verification passed.
- Independent evaluation passed with no findings.
- Deployed binary SHA-256 `2cfa6f42ab50cbd28e3a2eceb2546de02ee7b58f0449c07a6dfd0415d401d9e9`
  by replacing only `harvto-loop-50:0.2`.
- Preserved Claude `27090`, Codex `27092`, and worker `27542`; governess became
  PID `32762`.
- Two tracker timeouts occurred during observation while 24 post-warm-up Codex
  samples retained `W9` and populated cost/rate.
- `governess doctor 50` passed all checks with a healthy journal and empty
  bridge queues.
