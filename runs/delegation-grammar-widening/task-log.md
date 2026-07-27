# Task Log: delegation-grammar-widening

## 2026-07-26 — Claude (implementer)

Widened the exact-mechanical delegation classifier in
`loop-fork/src/loop/delegation-policy.ts` against the run-48 skip evidence
(79 `compound-or-unsafe-command` + 8 `command-not-in-delegation-grammar`).
The literal scanner now emits tokens (word / pipe / and / quiet-stderr) and a
pure structural parser accepts only `[cd <in-repo-path> &&] base
[2>/dev/null] [| head|tail|wc -l filter]`, reducing every accepted compound
to the existing single-command grammar with `safeScope`-validated scopes; the
grammar gained read-only `ls` (`scoped-list`) and `wc -l` (`line-count`)
inspect requests. TDD throughout: 30 new positive/negative cases landed red
before implementation, plus 4 regression tests for two fail-closed gaps the
independent evaluator found (unquoted `\n`/`\r` swallowed as whitespace;
escaped `\2>/dev/null` matching the stderr redirect) — both fixed. Evidence:
focused suite 95/95, full suite 848 pass with only the 4 known Codex-launch
baseline failures, biome clean on touched files, `bun run build` and
`git diff --check` pass; spec bundle in `specs/delegation-grammar-widening/`,
harness evidence in `loop-fork/runs/delegation-grammar-widening/`, and
independent `eval.json` in this directory.
