# Cleared lineage remote integration

## Problem

GitHub and Forgejo `main` are identical at
`4f8e132d353f2e123774335b6b82304fb7005332`, while the reviewed and installed
harness lineage continued on a separate history. The reviewed outbound
supervisor candidate `d20a5418cb384bdf443fbbca231e808e1d3602e4`
contains the current cleared lineage but does not descend from remote `main`.

Remote `main` has two unique commits. Patch-equivalence proves
`aa74ee73ced6b03d153d31656bdd611be74c5be0` is already represented in the
cleared lineage. The only remote-only tree addition is the root `README.md` in
`4f8e132d353f2e123774335b6b82304fb7005332`.

## Requirements

1. The integration commit descends from both reviewed candidate `d20a541` and
   remote main `4f8e132` without rewriting either history.
2. The resulting source tree preserves the reviewed harness implementation and
   adds the root README.
3. No older remote-main source version may replace a file from the cleared
   lineage merely to make the histories meet.
4. Full governed verification, an empty named baseline-failure list, a clean
   exact-commit build, and the changed-binary launch smoke must pass.
5. The exact integration SHA must receive supervisor concurrence before either
   remote `main` or the installed binary advances.
6. GitHub and Forgejo `main` must resolve to the same reviewed integration SHA.
7. Installation uses a recoverable backup and atomic regular-file replacement;
   the installed version and SHA-256 are independently re-derived afterward.

## Non-goals

- Rewriting remote history or deleting feature branches.
- Mutating the dirty primary checkout.
- Restarting or altering a healthy live loop.
- Folding additional backlog work into the release candidate.
