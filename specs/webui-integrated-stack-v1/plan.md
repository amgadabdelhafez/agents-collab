# Plan: Web UI integrated certified stack

## Approach

Branch from the refreshed GitHub `main`, merge the two exact certified heads,
and resolve only the two append-only registry conflicts by retaining both sides.
Then run combined verification and record a new integration eval.

## Sequence

1. Record the base, parent heads, worktree cleanliness, and conflict inventory.
2. Merge the T-00/T-01 head without modifying it.
3. Merge the theme/mobile/tailnet head and resolve only the two registries.
4. Prove parent ancestry, row preservation, syntax, and bounded diff scope.
5. Run combined focused/full tests, scoped static checks, build, and scoped
   diff validation.
6. Complete Harness evaluation, commit the integration receipt, and push only
   the feature branch.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| History | Preserve both parent commits | Keeps exact-SHA reviews valid for their original candidates |
| Conflict resolution | Additive registry union | Both files are append-only records |
| Product edits | Forbidden | Integration should certify composition, not change behavior |
| Remote action | Feature branch and replacement PR only | Keeps `main` behind the review gate |

## Affected subsystems

- Harness registry: combines four completed Web UI task records.
- Debt register: combines all component indicator rows.
- Web UI and loop control surface: verified together but not edited.

## Risks

- Duplicate or dropped registry rows. Mitigation: derive and compare row IDs
  against both exact parent blobs.
- Hidden feature interaction. Mitigation: run full regression, check, and build
  on the combined commit.
- Immutable parent logs contain four whitespace diagnostics. Mitigation: retain
  those exact reviewed blobs and diff-check every non-run path plus the new
  integration verifier separately.
- The repository-wide formatter scans generated Harness evidence. Mitigation:
  preserve its failed receipt, never rewrite evidence, and run Ultracite over
  the complete changed non-run code/config set derived from Git.

## Not doing

No product correction, history rewrite, main merge, deployment, or T-02 work.
