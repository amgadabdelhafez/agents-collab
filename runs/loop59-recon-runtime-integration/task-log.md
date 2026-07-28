# Loop-59 recon runtime integration

- Diagnosed the live five-pane topology as a divergent-branch runtime: Loop-59 had the newer routing/config work but not the recon/layout commits.
- Merged `codex/loop57-runtime-fixes` into `codex/pi-command-intake-prompts` while preserving run-scoped strict Claude MCP configuration and the later routing fixes.
- Kept semantic helper names in pane titles and restored compact model-family labels (`QWEN`, `GLM`) inside helper transcript rows without repeated request IDs.
- Added `routes`, `tools`, and `results` panes across the bottom of `harvto-loop-59`; persisted pane IDs `%5`, `%6`, and `%7` in the run manifest.
- Hot-swapped only Governess and helper display panes. Claude stayed PID 4081 and Codex stayed PID 4083.
- Focused suite passed 167/167; full `bun run test:ci`, build, installation, and `git diff --check` passed.
