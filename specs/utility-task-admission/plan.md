# Plan: Utility Task Admission

## Approach

Extend the existing durable route request rather than create a second router.
The request factory normalizes absent legacy input to `unknown`; public bridge
submission requires an explicit value; the pure router admits only
`separable`. This keeps old journal entries readable while making them fail
closed under the new policy.

## Sequence

1. Add the work-shape type, durable field, normalization, and route reason.
2. Require and parse `work_shape` at the bridge boundary.
3. Mark trusted mechanical hook submissions as separable and update agent
   guidance.
4. Add producer-backed bridge tests plus pure routing regression tables.
5. Run focused and full verification, record artifacts, and request an
   independent exact-SHA review.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Legacy records | Normalize missing input to `unknown` | Readable but never silently utility-eligible |
| Admission default | Current driver | One sequential locus is the safe default |
| Public schema | Explicit required enum | Missing evidence fails before persistence |
| Automatic hooks | Emit `separable` | Their grammar already proves a standalone bounded operation |

## Affected subsystems

- Task router: request schema and pure eligibility decision.
- Bridge utility tool: producer boundary and durable request creation.
- Delegation policy: trusted mechanical producer metadata.
- Agent guidance: caller contract.
- Router and bridge tests: producer-backed regression proof.

## Risks

- Existing callers omit the new field. Mitigation: bridge schema fails clearly,
  prompts are updated, and tests exercise the real producer boundary.
- Old journals lack the field. Mitigation: the router treats absence as
  `work-not-separable` and never upgrades it implicitly.

## Not doing

No live rollout, heuristic LLM classifier, dependency graph, or routing-policy
optimization is part of this slice.
