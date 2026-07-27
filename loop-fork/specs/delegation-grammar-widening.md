# delegation-grammar-widening

Task completed 2026-07-27T02:20:38Z, mode planned.

> **Reopened 2026-07-27T03:19Z — fail-closed re-audit remediation.** The first
> implementation was rejected by an adversarial fail-closed audit; the boundary
> breaks are fixed in a follow-up pass (see the "Fail-closed hardening" section
> of `specs/delegation-grammar-widening/spec.md`). Not to merge to
> `feat/babysitter-pane` until an independent re-audit is clean.

## What was built

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

## Decisions made

_No entries recorded._

## Open items at completion

_No entries recorded._

## Trajectory

- 001 - initial (2026-07-27T02:01:33Z)
- 002 - spec bundle + plan written; starting TDD RED (2026-07-27T02:01:46Z)
- 003 - fixed evaluator findings: newline fail-closed + escaped-fd redirect (2026-07-27T02:16:25Z)
- 004 - fail-closed re-audit remediation (2026-07-27T03:19:48Z): shared safeScope
  hardening (tilde, symlink realpath canonicalization, brace/glob, empty) + tokenizer
  hardening (control-char order, exotic Unicode whitespace, `#` comments, empty quoted
  args); `wc -l` pipe filter and `scoped-list`/`ls` dropped; `cd`-fold refused for
  command-kind requests; carry `head`/`tail` bound into the objective; `rg` unknown-flag
  rejected. +17 red-first tests (delegation suite 95 -> 112); full `bun test` at baseline
  (only the 4 known Codex-launch failures); `bun run build` and `git diff --check` clean.
  Pending independent adversarial re-audit before merge.
- 005 - first re-audit REJECTED (6 confirmed fail-opens); round-2 remediation
  (2026-07-27T03:47:52Z): realpathWalk rejects dangling symlinks (lstat check);
  tokenizer rejects unquoted glob/brace metachars (closes the rg pattern-slot
  escape); classifyGit rejects git magic pathspec (`:(exclude)`/`:!`);
  classifyGrep rejects modal params (output_mode/-c/-l/glob/type/head_limit);
  `wc`/`line-count` and `Glob`/`scoped-glob` dropped as broker-unsatisfiable.
  +19 tests (delegation suite 112 -> 125); full `bun test` at baseline (4 known
  Codex-launch fails); build + diff-check clean. git-pathspec / Grep-modal /
  scoped-glob fixes touch PRE-EXISTING deployed behavior. Re-audit re-running.
- 006 - second re-audit REJECTED (5 confirmed, 2 root causes); round-3 remediation
  (2026-07-27T04:12:09Z): (a) symlink+`..` lexical collapse — replaced realpathSync
  with physicalResolve (component-by-component kernel-style symlink/.. resolution on
  the raw, non-collapsed path), subsuming the dangling-symlink fix; (b) directory
  target for a single-file read — classifyRead/classifySourceSlice now require a
  regular file (statSync). +2 real-FS tests (delegation suite 125 -> 127); full
  `bun test` at baseline (4 known Codex-launch fails); build + diff-check clean.
  Third independent re-audit re-running (merge gated on a clean result).
- 007 - third re-audit REJECTED (4 confirmed: symlink corners + non-regular-file);
  round-4 ARCHITECTURE change (2026-07-27T04:39:46Z): after 3 rounds of symlink
  canonicalization escapes, physicalResolve now REFUSES to traverse any in-repo
  symlink (rejectWithin canonical root; follows only symlinks above the root),
  collapsing the whole symlink+`..` class into one provable rule; ENOENT keeps
  walking; backslash path values rejected; single-file readers require a regular
  file (statSync isFile, rejecting dir/FIFO/socket/device). +2 real-FS tests
  (delegation suite 127 -> 129); full `bun test` at baseline (4 Codex-launch
  fails); build + diff-check clean. Verified adversarial vectors via probe.
  Fourth independent re-audit was STOPPED mid-run at the operator's request
  ("don't do more rounds"). Round-4 fixes are green + probe-verified but NOT
  confirmed by an independent audit; merge remains a human decision. NOT merged.
