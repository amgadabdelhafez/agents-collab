# Verify: Provider-Neutral OSS Agent Seat

1. Exercise all ordered distinct pairs from `{claude,codex,oss}`.
2. Assert `gemini`, `cursor`, and `copilot` fail for agent, pair, review, plan
   review, only-mode flags, and resume launch.
3. Assert an arbitrary provider/model identifier is passed unchanged to
   OpenCode and GLM-5.2 is only the default.
4. Assert generated OpenCode config is run-scoped, bridge-only, source `oss`,
   and contains no credential value.
5. Assert persisted OSS sessions resume through their stored session ID.
6. Assert bridge and governess target the persisted OSS pane.
7. Run affected test files, `bun run check`, `bun run build`, and
   `scripts/verify.sh oss-agent-seat oss-agent-seat`.
