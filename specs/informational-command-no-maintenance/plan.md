# Plan: informational commands without maintenance

## Approach

Extract informational-request detection from the same argument-consumption
path used by `parseArgs`. Run that side-effect-free probe before public utility
commands, hidden helpers, and the global startup-maintenance block. When it
detects an active help/version token, render the response through the
config-independent information renderer and return.

Harden the realistic launch smoke separately by starting each candidate under
an allowlisted environment with disposable `HOME`, `CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, tmux directories, and a unique run identity, then assert no
matching run appears under the captured real home. Seed the disposable update
cache and compare the complete source prompt bytes against every generated
charter so certification is independent of network and truncation.

Route every confirmed-dead paired pre-handoff path through one idempotent
failure terminalizer bound to the exact prepared run storage. Preserve
external transport ownership and never treat tmux timeout/unknown as cleanup
authority.

## Sequence

1. Add parser-level tests that define positive, negative, malformed-prefix,
   and delimiter semantics for the side-effect-free information probe.
2. Dispatch detected information requests before all startup maintenance and
   add CLI zero-maintenance regressions for nested commands.
3. Isolate the realistic launch smoke from ambient loop, Claude, Codex, and
   tmux state; seed update throttling and add full-prompt and storage assertions.
4. Terminalize confirmed-dead paired startup/handoff races without rewriting
   completed manifests or clearing transport ownership from another launcher.
5. Run focused checks, the full repository verifier, and create a replayable
   eval with an empty baseline-failure list.
6. Commit the candidate and obtain an independent exact-SHA review. Hold live
   smoke and activation until governed teardown of run-101.

## Risks and mitigations

- Parser drift: share the parser's existing `consumeArg` traversal instead of
  maintaining a second option table.
- Help-looking option values: test spaced value flags and the `--` delimiter.
- Accidental live-state mutation: use only the isolated worktree and
  disposable homes; do not invoke any normal installed `loop` command.
- False certification from ambient variables: build the smoke environment
  from an explicit allowlist and assert the real storage root remains absent.
- False-dead cleanup: require a conclusive tmux probe before failure
  terminalization; required liveness timeouts remain nonzero without mutation,
  while optional window-option failures are logged before the required probe.
- Prompt truncation: compare the entire randomized source prompt buffer, not
  only a prefix sentinel, in every smoke manifest binding.
