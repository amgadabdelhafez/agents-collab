# lower-agent-release-integration Research

## Research Question

What existing implementation and release patterns allow the lower-agent feature
and later bridge fixes to ship together without regressing either behavior or
restarting the active loop?

## Candidates Reviewed

- `codex/lower-agent-router`: contains the verified pure router, durable utility
  job store, bounded tools, OpenAI-compatible transport, governess scheduling,
  and default pane. It cannot be installed alone because its shared bridge files
  predate later delivery fixes.
- `codex/codex-bridge-visible-tui`: contains visible Codex/Claude delivery,
  direct-delivery claims, reconnect handling, and draft-safety repairs. It lacks
  the utility worker and routing tools.
- Existing loop-fork single-binary release pattern: retain it so future loops,
  bridge servers, governess, and pane creation resolve one executable rather
  than introducing a second service lifecycle.
- OpenRouter workspace routing concepts: already adapted by the lower-agent
  component into provider-independent tier policy, with GLM-5.2 as the first
  default and a future local OpenAI-compatible endpoint path.

## Open-Source Patterns

- Merge overlapping changes semantically and test the union of their behavioral
  contracts, rather than resolving conflicts by taking one branch wholesale.
- Build into a sibling candidate, validate it, retain the current executable as
  a rollback artifact, then rename the candidate atomically over the target.
- Do not restart a live process merely because its executable changed on disk;
  verify process/pane identity and let the new release apply to future launches.

## Reuse Decision

Reuse both completed component implementations inside the existing binary and
adapt their overlapping bridge files additively. No new framework or daemon is
needed. Keep the active loop on its already-loaded runtime, while installing the
integrated binary as the default for newly launched loops.

## Sources

- `runs/lower-agent-router/research.md`
- `runs/lower-agent-router/live-canary.md`
- `runs/codex-bridge-visible-tui/task-log.md`
- `runs/claude-bridge-low-latency/artifacts/live-proof.md`
- https://openrouter.ai/workspaces/default/routing
- https://openrouter.ai/docs/guides/features/tool-calling
