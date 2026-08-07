# Tasks: Claude kickoff submit guard

1. **Capture producer evidence.**
   Copy the run-147 and run-148 `hooks/claude.jsonl` streams read-only from
   `/Users/amgad/.loop/runs/harvto-b1e274e66299/{147,148}`. Capture a real
   Claude Code `2.1.223` stranded-composer pane in an isolated throwaway tmux
   session with a unique name, an unresolvable development-channel server name,
   and no live run directory, repo identity, or port owned by run 148.

2. **Check in the fixture.**
   `loop-fork/tests/fixtures/claude-code/2.1.223/kickoff-channel-race/` with the
   normalized artifacts plus `fixture-index.json` recording producer version,
   capture command, terminal size, source paths, per-file SHA-256, and the
   normalization applied. Add the normalizer script that produced them.

3. **Add `loop-fork/src/loop/claude-kickoff.ts`.**
   `parseClaudeHookEvidence`, `kickoffTurnStarted`, `parseClaudeCliVersion`,
   `resolveKickoffCapability`, `classifyKickoffComposer`, and the evidence types.
   Pure, no I/O.

4. **Extend `TmuxDeps`.**
   Add `readTextFile`, `fileSize`, and `claudeCliVersion` members with real
   `defaultDeps` implementations.

5. **Add constants and the error type in `tmux.ts`.**
   `CLAUDE_KICKOFF_CONFIRM_MAX_POLLS`, `CLAUDE_KICKOFF_CONFIRM_POLL_DELAY_MS`,
   `CLAUDE_KICKOFF_RECOVERY_MAX_POLLS`, `CLAUDE_KICKOFF_HEALTHY_MAX`, and
   `ClaudeKickoffUnconfirmedError`.

6. **Wire the guard into `pasteLaunchBootstrap`.**
   Baseline before paste, bounded confirmation poll, one guarded recovery Enter,
   fail closed. `await` both call sites. Claude panes only.

7. **Record the observed CLI version on the manifest.**

8. **Named deterministic regressions** in the paired-launch test file:
   - `confirms a normal kickoff from hook progression`
   - `recovers a v2.1.223 channel-race stranded kickoff with one direct Enter`
   - `refuses to mutate a composer holding an unrelated human draft`
   - `never submits the kickoff twice once evidence shows the turn started`
   - `fails nonzero when no transcript or hook evidence ever arrives`
   - `cleans up owned startup resources after an unconfirmed kickoff`
   Plus unit regressions for `parseClaudeCliVersion` / `resolveKickoffCapability`
   proving the proven-healthy version keeps the fast path and an unknown newer
   version defaults to the guarded profile.

9. **Add `specs/claude-kickoff-submit-guard/verify.md` to the governed verify
   run** and confirm `scripts/verify.sh claude-kickoff-submit-guard` passes.

10. **Isolated smoke.** Unique temporary run directory and repo identity,
    bounded concurrency, non-network process stubs, `trap` cleanup, positive
    zero-survivor assertion. Never touches a live run directory, live repo
    identity, or a port owned by run 148.

11. **Full verification.** Focused tests, all bridge/launcher/governess suites,
    `bun run check`, `bun run build`, smoke, eval, clean scoped diff. No skipped
    or tolerated failures.

12. **Commit, request exact-SHA supervisor review over xchan, stop at the gate.**
    No merge, rebase, push to main, install, or deploy.
