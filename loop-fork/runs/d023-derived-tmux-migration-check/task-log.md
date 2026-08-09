# Task d023-derived-tmux-migration-check

## Objective

Make the tmux socket migration mechanically enforceable and prove the checker
is non-vacuous with independent seeded violations.

Regression: yes
Regression id: ambient-tmux-authority-reintroduction
Regression symptom: A new direct or authority-widening tmux call can contact the wrong server.
Regression guard: `bun run check:tmux-migration`

## Verification

- Implemented a TypeScript-AST source check and wired it ahead of lint, build,
  tests, and smoke in the root verifier.
- The checker resolves call-site lexical const string/argv aliases, spread
  prefixes, Bun/Node runner aliases, namespace runner imports, target flags,
  attach formatters, bare-session liveness, and exported pane-effect API
  shapes.
- Authority restrictions cover named imports/re-exports, namespace imports,
  plain export-star barrels, and namespace-export barrels. The only pane-string
  compatibility exception is the reviewed Governess path, interface, and
  approved member set.
- The source sweep exposed an ambient bridge delivery path. Capture, send,
  buffer load/paste/delete now use coherent manifest-derived socket and pane
  capabilities with SHA revalidation before effects.
- Focused: 274 passed, 0 failed, 1,161 assertions.
- Checker seeds: 26 passed, 0 failed, including independent namespace import,
  export-star, namespace-export, lexical-shadowing, spread-head, and paste
  regressions.
- Static: exact nine-file Ultracite check passed; `git diff --check` passed.
- Build: passed.
- Independent zero-write review: PASS.

## Recorded limitation

The checker is AST-based and resolves its explicitly supported file-local
lexical forms. It does not claim interprocedural runtime provenance or complete
semantic value-flow coverage for arbitrary `TmuxLiveness` production. Named
per-consumer degraded tests remain the enforcement for that residual.
