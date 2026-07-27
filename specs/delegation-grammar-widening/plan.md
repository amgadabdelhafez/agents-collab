# Plan: Delegation Grammar Widening

All changes live in `loop-fork/src/loop/delegation-policy.ts` plus its test
file `loop-fork/tests/loop/delegation-policy.test.ts`.

## Design

1. **Tokenizer refactor.** Rename the literal scanner to `literalTokens`,
   returning `ShellToken[] | undefined` where a token is
   `{kind:"word",value}` | `{kind:"pipe"}` | `{kind:"and"}` |
   `{kind:"quiet-stderr"}`. Same quoting/escape/secret/length rules as today.
   New top-level recognitions (everything else still bails):
   - single `|` → pipe token (`||` bails);
   - `&&` → and token (single `&` bails);
   - unquoted standalone token `2` immediately followed by `>/dev/null` at a
     token boundary → quiet-stderr token (any other `>`, `<`, fd, or spaced
     redirect bails). A `tokenQuoted` flag prevents `'2'>/dev/null` from
     matching.
   `literalArgv` becomes a thin wrapper: tokens that are all words.

2. **`decomposeSafeCompound(tokens)`** → `{cdTarget?, argv} | undefined`,
   pure structural parse of `[cd <p> &&] base [2>/dev/null] [| filter]`:
   - split on `and`: >2 segments → undefined; 2 segments → first must be
     exactly `cd <literal-non-glob-path>`;
   - split remainder on `pipe`: >2 segments → undefined; second segment must
     match the filter grammar (`head`/`tail` bare, `-n <digits>`,
     `-<digits>`; `wc -l` exact);
   - a trailing quiet-stderr token on the base is stripped; anywhere else it
     fails;
   - base must be non-empty words.

3. **`classifyBash`**: tokens → decompose → on failure keep
   `compound-or-unsafe-command`. If `cdTarget` present, resolve via
   `safeScope(root, cwd, target, allowRoot=true)`; failure →
   `cd-without-safe-scope` (new reason); success → derived intent with
   cwd = repoRoot/rel. Then the existing executable-path guard and classifier
   chain, extended with `classifyLs` and `classifyWc`.

4. **`classifyLs`**: `ls` + flags matching `/^-[1ahl]+$/` (others →
   `unsupported-ls-option`) + ≤4 literal non-glob paths (default `.`),
   resolved with `allowRoot=true` → eligible `scoped-list` inspect request.

5. **`classifyWc`**: exactly `wc -l <file...>` with 1–4 literal non-glob
   files (no flags beyond `-l`) → eligible `line-count` inspect request.
   `wc` alone or other flags → not this shape (falls through to grammar
   reason).

6. **Types**: add `"line-count"` and `"scoped-list"` to
   `DelegationOperation`. No existing reason/operation strings change.

## Task breakdown

See `tasks.md`. TDD: tests land and fail before each implementation slice.

## Blast radius

- Telemetry: new operation/reason strings are additive;
  `utility-observability.ts` aggregates by disposition only — verified.
- Bridge prompts: `bridge-guidance.ts` wording already covers the widened
  grammar generically — no change.
- Hook/proxy: consume `classifyDelegationIntent` — behavior for previously
  eligible shapes is unchanged (existing tests prove it).
