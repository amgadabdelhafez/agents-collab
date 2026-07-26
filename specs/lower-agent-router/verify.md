# Verify: Lower-Agent Router

## Routing and authority

- [x] Table fixtures route bounded inspect/edit/command work to utility.
- [x] Review work routes to the main peer.
- [x] Ambiguous, protected, destructive, remote, dependency, migration, and
      product-decision requests never route to utility.
- [x] A stale or missing governess epoch cannot claim or dispatch a job.
- [x] Duplicate route submissions create at most one active job.

## Worker isolation and tools

- [x] Slow/failed provider calls do not delay governess ticks.
- [x] Traversal, symlink escape, protected paths, secret paths, shell
      interpolation, forbidden commands, and oversized output are rejected.
- [x] Provider credentials are absent from prompts, traces, artifacts, and tool
      child environments.
- [x] Patch proposals include preimage hashes and never modify the source.
- [x] Guarded patch application remains disabled in P0.
- [x] Worker crash/restart resumes or safely fails durable jobs exactly once.

## Context, delivery, and telemetry

- [x] Utility requests contain only explicit job context and selected artifacts.
- [x] Either main agent can submit and receive a compact result.
- [x] Large results and patches are artifact references, not full bridge text.
- [x] Usage contains model, prompt/output/reasoning tokens, tool rounds, latency,
      provider cost when supplied, and aggregate job/run totals.
- [x] External supervisor absence/disconnect does not affect routing.
- [x] Headless and visible utility modes produce equivalent job results.
- [x] New paired loops place the utility observer at top-right by default.
- [x] `LOOP_UTILITY_PANE=0` preserves the three-pane layout.
- [x] Bridge delivery and governess capture use persisted main-agent pane
      targets in both layouts.
- [x] The compact pane shows live job state and latest tool/cost evidence.

## Proof commands

- [x] Focused new tests pass under `bun test tests/loop/...`.
- [x] `bun test` passes or unrelated baseline failures are recorded.
- [x] `bun run check` passes or unrelated baseline failures are recorded.
- [x] `bun run build` passes.
- [x] Fake OpenRouter end-to-end canary passes.
- [x] Live `z-ai/glm-5.2` canary passes when a credential is configured; otherwise
      the missing credential is explicitly recorded and no live claim is made.
- [x] `runs/lower-agent-router/eval.json` is PASS from an independent evaluator.

## Long-term promotion gate

No new task class is moved from main agents to a cheaper tier until replay/live
evidence records success rate, main-agent rework rate, latency, actual cost, and
estimated main-agent tokens avoided. Safety gates are never relaxed by model
quality alone.
