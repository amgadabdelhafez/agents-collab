# Task delegation-grammar-widening

Created: 2026-07-27T02:01:33Z
Mode: planned
Description: Widen exact-mechanical delegation classifier: safe compound decomposition (pipe filters, leading in-repo cd, trailing 2>/dev/null) plus ls / wc -l grammar

## What I changed

Refactored the literal scanner in `src/loop/delegation-policy.ts` into a
token emitter (word / pipe / and / quiet-stderr) and added a pure structural
parser that accepts only `[cd <in-repo-path> &&] base [2>/dev/null]
[| head|tail|wc -l filter]`, reducing accepted compounds to the existing
single-command grammar with `safeScope`-validated scopes. Extended the
grammar with read-only `ls` (`scoped-list`) and `wc -l` (`line-count`)
inspect requests. Hardened two fail-closed gaps found by the independent
evaluator: unquoted `\n`/`\r` are now rejected before whitespace handling,
and escaped characters set the quoted flag so `\2>/dev/null` cannot match
the stderr redirect. Added 34 tests red-first in
`tests/loop/delegation-policy.test.ts`.

## Why

Run 48 telemetry showed 192/206 delegation candidates skipped; the fixable
buckets were `compound-or-unsafe-command` (79) and
`command-not-in-delegation-grammar` (8). Spec:
`../specs/delegation-grammar-widening/spec.md` (repo root).

## Notes

Focused suite 95/95; full suite 848 pass / 4 fail — exactly the known
Codex-launch baseline. Biome clean on touched files; build and
`git diff --check` pass. Independent eval (verdict: pass, 29/29 adversarial
probes) at repo-root `runs/delegation-grammar-widening/eval.json`.
`bun run check` fails on 9 files of pre-existing lint debt unrelated to this
change.
