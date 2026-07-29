# Driver bootstrap role activation

## Problem

The constant-size launch bootstrap verifies and opens the authoritative charter
but does not say whether the newly launched agent is the primary driver or the
supporting reviewer. On recovered Harvto run 100, the fresh primary verified
its charter, then said no task was assigned and waited until the supervisor
sent a role correction. The complete charter contained a concrete mission, but
the transport bootstrap left the fresh session in a generic politeness mode.

## Goal

After hash-verifying its charter, a fresh primary agent immediately initiates a
concrete charter mission, while a supporting peer continues to wait for a
targeted request unless the charter explicitly assigns separate work.

## Requirements

1. Launch bootstrap construction must receive the agent's explicit paired role:
   `primary` or `support`.
2. A primary bootstrap must say that, after verification, a concrete mission in
   the charter is already assigned work and must begin immediately without
   waiting for another task assignment or role correction.
3. A support bootstrap must say to follow the charter but wait for a targeted
   request unless the charter explicitly assigns separate work.
4. An interactive primary charter with no task remains authoritative: the
   conditional wording must not invent work when no concrete mission exists.
5. Both bootstrap variants remain below the existing 1 KiB transport ceiling,
   contain no founder-charter body, and retain exact SHA-256 fail-closed checks.
6. Existing full primary/peer prompts, paired topology, and live sessions are
   unchanged. Harvto run 100 remains read-only.

## Non-goals

- Changing the complete primary or peer charter content.
- Changing utility delegation, review workflow, or founder authority.
- Replaying a task into an existing persistent session.
- Mutating or hot-swapping the active Harvto workspace.

## Acceptance criteria

- [x] Primary and support bootstraps have distinct explicit role activation.
- [x] Concrete primary missions start without a second assignment prompt.
- [x] Support peers continue to wait unless separately assigned by the charter.
- [x] Both variants remain hash-bound, fail closed, and below 1 KiB for a
      realistic charter of at least 8 KiB.
- [x] Focused and full repository verification pass with an empty baseline.
- [ ] Exact-SHA independent review concurs before deployment.
