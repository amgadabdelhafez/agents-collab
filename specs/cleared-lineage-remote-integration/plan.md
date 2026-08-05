# Plan

1. Start from exact reviewed candidate `d20a541` in an isolated worktree.
2. Merge GitHub `main` with an explicit merge commit, resolving any duplicate
   effort change in favor of the newer cleared lineage.
3. Prove the merge tree differs from `d20a541` only by the root README and this
   task's specification/evidence artifacts.
4. Run focused lineage checks and the complete governed verifier.
5. Commit the exact integration candidate and obtain stamped supervisor review.
6. Build the committed blob, run the changed-binary smoke, and record SHA-256.
7. Fast-forward GitHub and Forgejo `main` to the exact reviewed commit.
8. Recheck live-run safety, install by atomic backup and rename, verify installed
   bytes and version, and announce exact provenance.
