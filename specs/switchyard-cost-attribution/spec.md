# Switchyard routed task attribution

## Problem

The live log inspected on 2026-09-12 contains 14 rows with token counts but no cost
field. `task`, `trial_id`, and `session_id` are null throughout, `tier` is an empty
string, and `fallback_reason` is absent in some rows. Loop does not yet send
`x-switchyard-intake-task`; timestamp windows cannot reliably attribute concurrent
routed calls to one task.

## Scope

- Add request-bound task identity to `PiProviderSpec`.
- Send `x-switchyard-intake-task` through Pi model headers only for loopback gateway
  endpoints.
- Bind utility Au Pair requests to the Loop run ID derived from their owning `runDir`.
- Preserve direct OpenRouter behavior without the Loop-specific header.

## Non-goals

- Do not ingest or derive routing-log cost in this repository.
- Do not change Switchyard configuration or restart it.
- Do not change bundled pricing or usage-tracker behavior.
- Do not build or install the Loop binary.

## Decision

Use `Model.headers`, the request mechanism exposed by pi-ai, rather than a parallel
provider-header abstraction. This keeps the value attached to the exact model used for
the request and supports both the registered gateway model and catalog-model override.

## Limits

The fallback run ID is unique within a repository, not across repositories. A consumer
of the global Switchyard log must not assume that a bare run ID uniquely identifies a
harness task. Repository qualification and a harness-task join remain follow-up work.

The existing IPv6 endpoint classification in `utility-runtime.ts` still needs a separate
fix before the IPv6 path proven at the Pi boundary is reliable through production routing.
This slice does not replace the gateway model's zero cost rates, so Loop's own Pi usage
cost remains zero until token pricing is addressed separately.
