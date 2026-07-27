# bridge-idle-delivery task log

- Live incident: loop-48 Codex verdict message `3c584744` stayed pending; the
  idle Claude composer showed the dim type-ahead suggestion "wait for codex's
  verdict", which a plain tmux capture cannot distinguish from a typed draft,
  so `isClaudePaneReady` never passed. The 250 ms retry loop also held a fresh
  delivery claim through each 3 s readiness poll, hiding the head message from
  `receive_messages` most of the time.
- TDD: four regressions written and observed failing before the fix (ghost
  readiness unit, ghost delivery e2e, no-claim-during-wait, consumed-mid-wait
  abort); ghost styling ground truth captured from the live pane
  (`ESC[39m❯ ESC[2m…ESC[0m`, SGR dim).
- Fix: `claudeComposerText` strips dim spans and residual ANSI from styled
  captures; Claude readiness/confirm paths capture with `-e`; delivery claims
  are acquired only after pane readiness, with pending + single-attempt
  readiness re-checks under the claim before injection.
- Four existing tests updated for the added in-claim readiness capture (one
  choreography index each; two exact spawnSync sequences gained one
  capture-pane entry).
- Verification: bridge 75/75; full suite 806 passed with the same four
  baseline Codex-launch failures; build, `git diff --check`, and biome on the
  touched files all clean.
