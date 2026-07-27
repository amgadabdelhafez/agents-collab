# Governess Usage Snapshot Cost Stability — Run Log

- 2026-07-26: Run 50 reproduced cost/quota flicker while transcript-backed model,
  context, tokens, and activity remained populated.
- 2026-07-26: Existing secret-free diagnostics recorded alternating tracker
  snapshots and `The operation was aborted.` at the 1.5-second timeout.
- 2026-07-26: Selected a pricing-only local fallback so transient I/O cannot
  blank cost while missing quota observations remain semantically missing.
- 2026-07-26: Focused pricing/governess suites passed 68/68. Full suite reported
  828 pass / 4 unchanged Codex model/config baseline failures. Build and
  `git diff --check` passed; `bun run check` could not run because `ultracite`
  is unavailable in the isolated worktree. Root `scripts/verify.sh` completed
  but remains placeholder orchestration.
- 2026-07-26: Independent evaluator returned PASS with no implementation
  findings and confirmed equal Claude/Codex costs on AbortError and 503 paths.
- 2026-07-26: Deployed only `harvto-loop-50:0.2`; governess PID changed from
  44995 to 73308 while Claude 27090, Codex 27092, and worker 27542 were
  preserved. Ten consecutive samples kept Codex cost/rate at `$8.82/$26`.
  Samples 1-3 had no current tracker quota (`S8 · —`) yet retained cost,
  directly proving the pricing-only fallback. Samples 4-10 showed `W8` after
  tracker recovery. Governess doctor passed every check with a healthy journal
  and zero pending/dead-letter bridge controls.
