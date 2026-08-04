# Utility task admission

## Problem

Bounded work is not necessarily parallel work. A small packet can still depend on intermediate output from another lane, so routing it to Nanny or Au Pair can create idle queues, duplicated work, and stale results.

## Requirement

Utility routing must admit only work explicitly classified as `separable`: the packet can finish without intermediate output from another lane. `sequential`, `unknown`, omitted, or invalid work shape remains with the current driver.

The admission gate is additive. Existing review, authority, safety, capability, risk, and scope rules keep their precedence and continue to fail closed. Governess remains the routing authority. The current Direct, Nanny, and Au Pair execution topology does not change.

Explicit `route_task` calls must provide `work_shape`. Trusted automatic hook packets may set `separable` only for their already deterministic mechanical inspection.
