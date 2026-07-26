# Lower-Agent Adoption Task Log

- 2026-07-26: Diagnosed loop 45. Utility runtime was ready but no job journal
  existed; Claude loaded `route_task` and used native tools instead. Governess
  only processed pending requests, confirming a delegation adoption gap.
- 2026-07-26: Created isolated worktree and follow-on spec. No loop-45 process,
  pane, queue, or state was modified.
- 2026-07-26: Implemented deterministic mechanical-intent classification,
  Claude pre-tool auto-routing, Codex missed-candidate observation, explicit
  route telemetry, mandatory route-first guidance, and pane adoption counters.
- 2026-07-26: Final independent focused acceptance suite passed 258/258.
  `bun run build` and `git diff --check` passed. Full suite passed 769/773; the
  same four failures
  reproduce in the untouched canonical checkout and are stale Codex
  model/config assertion baselines in `paired-options.test.ts` and
  `runner.test.ts`.
- 2026-07-26: Repository `scripts/verify.sh` completed; its lint, typecheck,
  unit, and integration commands remain explicit CONFIGURE placeholders.
- 2026-07-26: Pre-release loop-45 identity snapshot:
  `%0` PID 13109 (claude), `%1` PID 13111 (codex-aarch64-a), `%3` PID 13469
  (loop), `%2` PID 13467 (loop). No input, signal, restart, or pane operation
  was sent to the session.
- 2026-07-26: Independent evaluation initially failed on inconsistent
  protection for `.claude`/`.aws` and raw caller idempotency in telemetry.
  Added one shared protected-path policy used by classifier, router, and broker,
  adversarial coverage across every enforceable tool grammar, and hashed
  caller idempotency before both job and telemetry persistence. Re-evaluation
  requested; release remains gated on PASS.
- 2026-07-26: A second independent review found nested protected directories
  were not covered by the first shared policy. The policy now treats credential
  and agent-control directory names as protected segments at any depth and
  recognizes nested governing specs and architecture trees; broker git
  pathspecs exclude these nested roots too. Added classifier/router/broker
  regressions and requested another evaluation.
- 2026-07-26: A third independent review expanded the central policy to all
  supported-agent control roots and common MCP/custom-agent instruction files,
  case-insensitively at any depth. Independent evaluator verdict is PASS in
  `eval.json`; release gate opened.
