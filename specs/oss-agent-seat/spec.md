# Spec: Provider-Neutral OSS Agent Seat

## Decision

The supported full-agent topology is `claude`, `codex`, and `oss`. The `oss`
seat is backed by OpenCode and accepts any configured provider/model identifier;
`openrouter/z-ai/glm-5.2` is the default profile, not a hard-coded dependency.

Gemini, Cursor, and Copilot are retired from new launch, pairing, review, and
resume selection. Historical manifests containing those identifiers remain
readable for diagnosis and reaping, but cannot start or resume an agent.

## Required behavior

1. `oss` is accepted anywhere a full agent can be selected: driver, peer,
   reviewer, plan reviewer, single-agent mode, and either side of paired tmux.
2. `--oss-only`, `--oss-model`, and `--oss-reviewer-model` are supported.
3. The default OSS model is `openrouter/z-ai/glm-5.2`; any non-empty OpenCode
   provider/model identifier can override it.
4. The adapter launches `opencode run` with JSON events, a run-scoped session,
   run-scoped configuration, the loop bridge MCP server, and explicit
   permission policy. It must not inherit unrelated user MCP configuration.
5. OSS session IDs, hooks, bridge identity, pane targets, usage, recovery, and
   handovers are persisted and observed like the native seats.
6. Gemini, Cursor, and Copilot flags, aliases, model flags, and new bridge
   targets fail closed with a migration message naming `oss`.
7. Existing manifests using a retired identifier can be inspected and reaped;
   attempting to relaunch one fails before creating a pane or process.
8. Provider credentials remain external to prompts, manifests, argv, traces,
   and repository files. The adapter uses provider-native credential lookup or
   a mode-0600 configured key file.
9. Selecting `oss` as reviewer makes it an advisory reviewer unless the run's
   governing policy explicitly grants it approval authority. No model gains
   release authority merely by occupying a seat.

## Acceptance

- Parser tests prove every valid Claude/Codex/OSS pairing works in either order.
- Parser tests prove retired agents and flags are rejected.
- Command tests prove arbitrary model IDs reach OpenCode without rewriting.
- Config tests prove only the run bridge is injected and the source is `oss`.
- Resume tests prove OSS sessions resume and retired sessions fail closed.
- Bridge/governess tests prove OSS routing, observation, and recovery use the
  persisted pane rather than numeric pane assumptions.
- Focused suites, full governed verification, build, and an eval are green.

## Non-goals

- Claiming that every OSS model is equally capable or safe.
- Automatically granting an OSS reviewer release-gate authority.
- Reusing the bounded Au Pair worker protocol as a full-agent session.
- Deleting historical evidence for retired agents.
