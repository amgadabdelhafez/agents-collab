# Verification

- `git merge-base --is-ancestor d20a541 HEAD` succeeds.
- `git merge-base --is-ancestor 4f8e132 HEAD` succeeds.
- `git cherry d20a541 4f8e132` marks `aa74ee7` patch-equivalent and only the
  README commit as materially absent before integration.
- The merge preserves the cleared-lineage versions of `constants.ts` and
  `tmux.ts`; the root README matches remote main byte-for-byte.
- `scripts/verify.sh cleared-lineage-remote-integration
  cleared-lineage-remote-integration` passes at the committed candidate SHA.
- The exact committed binary passes the repository's non-mutating changed-
  binary launch smoke.
- The stamped supervisor review binds its verdict to the exact integration SHA.
- GitHub main, Forgejo main, and the installed binary provenance all bind to
  that reviewed SHA.
