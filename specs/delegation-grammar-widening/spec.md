# Spec: Delegation Grammar Widening

## Problem

Run 48 delegation telemetry (`utility/delegation.jsonl`, 2026-07-26) shows 192 of
206 candidate operations were skipped instead of delegated. The two fixable
buckets are `compound-or-unsafe-command` (79 events — `classifyBash` bails
whenever `literalArgv` cannot parse the command as a single literal argv) and
`command-not-in-delegation-grammar` (8 events — read-only commands like `ls`
and `wc -l` that the grammar does not recognize).

## Goal

The exact-mechanical classifier in `loop-fork/src/loop/delegation-policy.ts`
delegates a small set of provably safe compound shapes and two additional
read-only commands, while everything else keeps failing closed.

## Non-goals

- No shell evaluation or expansion; the classifier stays pure and exact.
- No arbitrary pipelines, no redirects other than a trailing `2>/dev/null`,
  no chained commands other than one leading in-repo `cd`.
- No mutation commands, no Codex-side enforcement changes, no new
  `UtilityRequestKind` or capability values.
- Output-limiting pipe filters `head`/`tail` are carried into the delegated
  objective as an evidence bound (never silently dropped); `wc -l` as a pipe
  filter is refused because it changes the *kind* of evidence, not just the
  bound.

## Background

The classifier feeds the Claude PreToolUse hook (enforce) and the Codex
app-server observer (observe-only). Blast radius per `docs/dependency-map.md`:
delegation classifier changes also touch telemetry (`delegation.jsonl`
operations/reasons are recorded verbatim) and bridge prompts.
`utility-observability.ts` aggregates by disposition only, and
`bridge-guidance.ts` describes delegation generically ("bounded mechanical
inspection"), so new operation/reason strings are additive and safe.

## Accepted shapes

1. Compound decomposition, each reducing to the existing single-command
   grammar (`classifyGit`/`classifyRg`/`classifySourceSlice`) with scopes
   still validated by `safeScope`:
   - safe command piped to exactly one of `head` or `tail` (bare, `-n <digits>`,
     or `-<digits>`, count ≥ 1); the bound is carried into the objective.
     `wc -l` is **not** accepted as a filter (evidence-kind change).
   - leading `cd <path-inside-repo> && <inspect-command>` — the `cd` folds into
     the intent cwd before scope resolution, but **only** for inspect-kind
     requests; folding into a command-kind request (`run_check`) is refused
     because `UtilityRouteRequest` carries no cwd and the check would run from
     the wrong directory;
   - trailing `2>/dev/null` on the base command.
   Shapes compose only in that fixed order: `[cd <p> && ] base [2>/dev/null]
   [| head|tail]`.
2. No grammar extension survives. The re-audit confirmed that `ls`
   (`scoped-list`), `wc -l` (`line-count`), and the pre-existing `Glob`
   (`scoped-glob`) all map to an operation **no** broker tool can satisfy: of
   the six tools, `search_repo` is text-only, `read_file` needs a file (not a
   directory), `run_check` allowlists only `bun test` / `npx vitest run`, and
   `git_status` / `git_diff` / `propose_patch` do not list. A directory listing,
   a filename glob, and `wc -l` on a directory (lexically indistinguishable from
   a file) are therefore unsatisfiable. All three fail closed, and the `Glob`
   tool is no longer delegable at all.
3. Broker-satisfiability trim (independent gate audit). Two further shapes
   were dropped because the broker cannot produce their evidence:
   - **`focused-check`** (`bun test` / `npx vitest run`) — its `readScope` held
     only the leaf test file, but `run_check` needs a directory-scoped cwd plus
     a regular-file target, so the request could never be satisfied. The whole
     command-kind category is dropped; `bun test`/`npx vitest run` are handled
     natively. (No command-kind operation remains.)
   - **`git diff` flags** — only `--name-only`, `--cached`, `--staged` are kept
     (the `git_diff` tool reproduces them). `--stat`, `--name-status`, and
     `-U<n>` are dropped: the tool has no diffstat/name-status/context control,
     so it would silently return a different evidence kind.

## Acceptance criteria

- [ ] Each accepted shape above classifies eligible with correct operation and
      root-relative `readScope`.
- [ ] Negative shapes stay ineligible: pipe to arbitrary commands, two pipe
      stages, non-digit filter counts, `>`/`2>` to real files, `cd` outside
      the repo or into governed paths, `&&` chains of two mutating commands,
      multiple `&&`, base commands outside the grammar (a pipe filter never
      blesses the base), `ls` with unsupported flags or glob/out-of-repo
      paths, `wc` without `-l` or without files.
- [ ] Full `bun test` matches baseline: 4 known Codex-launch failures only.
- [ ] `bun run check` and `bun run build` pass.

## Fail-closed hardening (re-audit remediation)

An adversarial fail-closed audit rejected the first implementation. The
following boundary breaks were reproduced by importing `classifyDelegationIntent`
and are fixed here, each with a red-first regression test. Shared fixes live in
`safeScope`/`literalTokens` so the Read/Grep/Glob classifiers are covered, not
only Bash.

- **Tilde** — a leading `~` is never expanded by node's path join, so it would
  masquerade as an in-repo scope while the shell reads `$HOME`. `safeScope`
  rejects any value starting with `~`.
- **Symlink escape** — `safeScope` now canonicalizes root and target with
  `realpathSync` (walk-up-to-nearest-existing-ancestor), the sync mirror of the
  worker layer's `assertRealContainment`; an in-repo symlink pointing outside is
  rejected.
- **Brace / glob metacharacters** — rejected in `safeScope` (they are not
  expanded, so a braced path must not collapse to a fabricated in-repo scope).
- **`cd -`** — the compound parser rejects a `cd` target starting with `-`
  (`$OLDPWD`/option, not a literal path).
- **Backslash-newline** — the tokenizer rejects raw NUL/newline/CR *before* the
  escape branch, closing a channel that smuggled a raw newline into a token.
- **Exotic Unicode whitespace** — the tokenizer splits words only on ASCII
  space/tab; other JS `\s` characters (NBSP, U+2028, U+FEFF, …) are literal to
  bash, so it fails closed rather than mis-splitting.
- **`#` comments** and **empty quoted args** — the tokenizer honors `#`
  comments and no longer silently drops `''`.
- **Pipe filter** — `wc -l` refused (evidence-kind change); `head`/`tail` bounds
  are validated (count ≥ 1) and carried into the objective/acceptance.
- **`cd`-fold into a command** — refused (see Accepted shapes #1).
- **`ls` / `scoped-list`** — dropped (see Accepted shapes #2).
- **`rg` unknown flags** — an unrecognized leading flag (e.g. `--pre <script>`,
  which runs an arbitrary program per file) is rejected instead of being treated
  as the search pattern; path args starting with `-` are rejected.

### Second round (independent re-audit findings)

The first independent re-audit rejected the above with six more confirmed
fail-opens; all are fixed here (red-first) and re-audited again:

- **Dangling symlink** — `realpathSync` throws `ENOENT` on a symlink whose
  target does not exist, and the walk-up formerly re-appended it as a plain
  in-repo segment (TOCTOU: creating the target later resolves it out of the
  repo). `realpathWalk` now `lstat`-checks each `ENOENT` cursor and fails closed
  when it is a symlink.
- **Brace/glob in the pattern slot** — `safeScope` only guards *path* args, so
  `rg {x,/etc/hosts} src` smuggled an out-of-repo read through the (unchecked)
  pattern. The tokenizer now rejects any **unquoted** glob/brace metacharacter
  (`{ } * ? [ ]`) in every word — bash would expand it into different args.
- **git magic pathspec** — `git diff -- :(exclude)src` / `:!src` are not literal
  paths (they diff everything *except* the named path, leaking governed files).
  `classifyGit` rejects any `--`-pathspec starting with `:`.
- **`wc -l` on a directory** — unsatisfiable and indistinguishable from a file
  lexically → `wc`/`line-count` dropped entirely (see Accepted shapes #2).
- **Native Grep modal params** — `output_mode:count`, `-c`/`-l`, `glob`, `type`,
  `head_limit`, context lines change the evidence kind or scope and cannot be
  honored by `search_repo`; `classifyGrep` now accepts only a plain content
  search (`{pattern, path, -i, -n}`, `output_mode==='content'`).
- **`Glob` / `scoped-glob`** — pre-existing and broker-unsatisfiable → dropped
  (see Accepted shapes #2). `Glob` is now non-delegable.

Live-boundary note: the git-pathspec, Grep-modal, and `scoped-glob` fixes touch
behavior that is **pre-existing on the deployed `feat/babysitter-pane`
classifier** (not new to this diff). They are fixed here because a clean
fail-closed re-audit is the merge gate; the net effect is that `Glob` and modal
`Grep` calls are no longer delegated (handled natively instead).

### Third round (independent gate audit — satisfiability + cosmetics)

The independent merge-gate audit (evaluator ≠ implementer) found the security
boundary fully closed and surfaced only two satisfiability shapes and two
cosmetic tokenizer gaps, all fixed here (red-first). Every change is stricter
(monotonic toward fail-closed), so no further audit is required.

- **`focused-check` unsatisfiable** — dropped (see Accepted shapes #3).
- **`git diff --stat`/`--name-status`/`-U<n>`** — dropped (see Accepted shapes #3).
- **Double-quoted backslash** — bash keeps a backslash before an ordinary char
  inside double quotes, but the tokenizer dropped it, so `rg foo "sr\c"` routed
  a different in-repo path (`src`) than the command read. The escape branch now
  preserves the backslash in double-quote context, and `safeScope` rejects the
  backslash-bearing path — matching the single-quote behavior and bash.
- **Unquoted parentheses** — `(` and `)` were not in the metacharacter set, so a
  paren-bearing arg routed a bogus scope. Added to `SHELL_META`; unquoted parens
  now fail closed (bash treats them as syntax anyway).

Removed operations: `scoped-list`, `line-count`, `scoped-glob` (the first two
were introduced in this change; `scoped-glob` was pre-existing). New additive
reasons: `cd-fold-command-unsupported`, `unsupported-rg-option`,
`git-diff-magic-pathspec`, `grep-modifier-unsupported`. No existing reason
string was renamed.

### Third round (independent re-audit findings)

The second re-audit rejected the above with five more confirmed fail-opens,
collapsing to two root causes; both fixed here (red-first) and re-audited:

- **Symlink + `..` lexical collapse** — `safeScope` resolved
  `realpathWalk(resolve(join(cwd, value)))`, but `resolve()`/`join()` fold
  `link/..` away *before* any symlink is followed, and `realpathSync` itself
  collapses `link/..` lexically on some platforms — so `link/../data.txt`
  (in-repo `link` → outside) was laundered into the in-repo scope `data.txt`
  while the kernel physically reads the outside file. Fixed by replacing
  `realpathSync` with **`physicalResolve`**, a component-by-component walk that
  follows symlinks and applies `..` against the resolved-real parent (POSIX
  kernel semantics), on the raw (non-`..`-collapsed) path. This also subsumes
  the earlier dangling-symlink fix (a dangling link is resolved to its true
  target location and rejected only if that is outside the repo).
- **Directory target for a single-file read** — `classifyRead` and
  `classifySourceSlice` accepted an existing directory as a line-addressable
  file, emitting a `read_file` request that cannot be satisfied (EISDIR). They
  now require a regular file (`statSync().isDirectory()` check in `safeScope`).

### Fourth round (independent re-audit findings — architecture change)

The third re-audit rejected the above with four more confirmed fail-opens, all
symlink-containment corners (`physicalResolve`'s ENOENT fast-path treated
`ghost/../link` as literal; a backslash path was rewritten by
`normalizedRelative` into a symlink-traversing scope) plus non-regular-file
targets (FIFO/socket/device passed the directory-only guard). After three
consecutive rounds of symlink-canonicalization escapes, the fix is an
**architecture change** rather than another patch:

- **Refuse to traverse any in-repo symlink.** `physicalResolve` now takes a
  `rejectWithin` root and fails closed on any symlink component *inside* the
  canonical repo root, while still following symlinks *above* it (macOS `/var`).
  A delegated path therefore can never cross an in-repo symlink, which collapses
  the entire symlink-plus-`..` escape class into one provable rule. The ENOENT
  branch keeps walking (a later `..` can return to a real in-repo symlink)
  instead of trusting the remainder as literal. Cost: in-repo paths that cross a
  symlink (e.g. `node_modules/.bin`) are non-delegable and run natively.
- **Reject backslash path values** in `safeScope` (POSIX-literal but rewritten
  to `/` by `normalizedRelative`, so the returned scope would differ from the
  validated path).
- **Require a regular file** for single-file readers (`statSync().isFile()`),
  rejecting directories, FIFOs, sockets, and devices — `read_file` can line-read
  only a regular file.

Re-verified by a fresh independent adversarial audit before merge.

## Out-of-scope risks

Claude hook enforce path and Codex proxy observation consume
`classifyDelegationIntent` directly — reasons/operations must stay stable for
existing shapes (no renames of existing strings).

## Approval

Shapes, evidence, and constraints were specified directly by the human
operator in the task request (2026-07-26); this bundle transcribes that
request.
