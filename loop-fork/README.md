# loop fork

Dead-simple Bun CLI that runs `codex` and `claude` in a loop. Uses `tmux` to run the interactive TUIs side-by-side. Codex and Claude talk to each other through the [Codex App Server](https://developers.openai.com/codex/app-server) and [Claude Code Channels](https://code.claude.com/docs/en/channels-reference).

This is an independent fork of [axeldelafosse/loop](https://github.com/axeldelafosse/loop) carried inside [amgadabdelhafez/agents-collab](https://github.com/amgadabdelhafez/agents-collab). The original project is MIT licensed; the original copyright notice is preserved in `LICENSE.md`.

Install:
```bash
curl -fsSL https://raw.githubusercontent.com/amgadabdelhafez/agents-collab/main/loop-fork/install.sh | bash
```

Run:
```bash
loop
```

or

```bash
loop --prompt "Implement {feature}" --proof "Use {skill} to verify your changes" --tmux
```

By default `loop` uses Claude as the main worker and Codex as the reviewer. To run Codex as the main worker instead:

```bash
loop --agent codex --tmux
```

## [Agent-to-agent pair programming](https://axeldelafosse.com/blog/agent-to-agent-pair-programming)

One agent is the main worker, the other acts as a reviewer. They work together on a PLAN.md and iterate until they both agree the task is done. Then the main worker creates a draft PR.

## What this is

This _is_ a "meta agent loop" to help coding agents become long-running agents. Stop baby sitting your agents: let them iterate on tasks with clear proof requirements until they are done. Run multiple reviews to continue the feedback loop.

This _is not_ an "agent harness" and the goal isn't to re-invent the wheel: `loop` leverages existing agent harnesses like `codex` and `claude`, with their own implementation of the "agent teams" orchestration. The models are getting better very quickly and they are highly optimized for their respective harnesses.

## What it does

- Runs in paired mode by default: one agent does the work, the other stays available for review/support
- Keeps Claude and Codex sessions persistent across iterations and bridges messages between them
- Routes live tmux bridge traffic through the visible paired panes, so review asks land in the reviewer TUI instead of disappearing into a background transport
- Stores paired run state under `~/.loop/runs/...` so runs can be resumed by run id or session/thread id
- Loops until the task is proven done, then runs reviews and creates a draft PR

## Setup

**IMPORTANT**: you SHOULD run this inside a VM. It is NOT safe to run this on your host machine. The agents are running in YOLO mode!

- Use Docker or [Lume](https://cua.ai/docs/lume/guide/getting-started/introduction) to create a sandbox VM
- Install nvm, node, npm and bun
- If you plan to use Playwright: `bun x playwright install chromium`
- Install [Codex](https://github.com/openai/codex) and [Claude](https://code.claude.com/docs/en/overview#get-started)
- Install Claude "Agent teams" and Codex "Multi-agents" experimental features
- Install git and gh CLI
- Create a GitHub fine-grained personal access token
- Once you are done, take a snapshot of your "golden image" (e.g. `lume clone`)
- Now you can even set up Tailscale to SSH remotely to your sandbox

## Requirements

- `codex` and/or `claude` installed and logged in
- [tmux](https://github.com/tmux/tmux) if you want to run the TUIs side-by-side
- [Bun](https://bun.com) to build/run from source (prebuilt binaries do not require Bun)

## Install prebuilt binary

```bash
curl -fsSL https://raw.githubusercontent.com/amgadabdelhafez/agents-collab/main/loop-fork/install.sh | bash
```

Installer currently supports macOS and Linux and installs `loop`, `claude-loop`, and `codex-loop` to `~/.local/bin` by default.

## Quick start

```bash
# run from source
./loop.ts --prompt "Implement {feature}" --proof "Use {skill} to verify your changes"

# start paired interactive tmux workspace with no task yet
./loop.ts

# open live panel of running claude/codex instances
./loop.ts dashboard

# build executable
bun run build
./loop --prompt "Implement {feature}" --proof "Use {skill} to verify your changes"

# start paired interactive tmux workspace with no task yet
./loop

# open live panel explicitly
./loop dashboard
```

Some notes:

- Default mode is paired: `--agent` selects the primary worker and the other model stays available as reviewer/support.
- You can pass prompt text positionally (`loop "Implement {feature}"`) or via `--prompt`.
- `--proof` is strongly recommended for autonomous task runs and should describe how to prove the task works (tests, commands, and checks to run). Be specific.
- Running with no args starts the same paired interactive tmux workspace as `loop --tmux` and waits for you to provide the first task in the TUIs. This human-driven mode does not require a prewritten `PLAN.md`, Harness task, or queued slice.
- `loop --tmux` still works explicitly and behaves the same as the default `loop` command.
- If the input is plain text (not a `.md` path), `loop` first runs a planning step to create `PLAN.md`, then uses `PLAN.md` for the main loop.
- Loop prompts instruct agents to maintain `PLAN.md` and `status.md` for sustained sessions. `PLAN.md` holds the current plan, decisions, acceptance criteria, and verification approach; `status.md` is the running handoff with what changed, proof/checks run, open questions, risks, and next steps for the next session.
- `loop dashboard` opens the live panel for active sessions, recent paired runs, and tmux sessions.
- If no prompt is provided and options are present, `loop` will use `PLAN.md` if it exists.

## Paired mode and resume

Paired mode is the default. `loop` starts one primary worker (`--agent`, default: `claude`) and keeps the other model available as a persistent reviewer/support agent. They coordinate directly through the built-in bridge instead of asking the human to relay messages.

The primary worker is instructed to ask the paired reviewer for validation and feedback every few concrete steps, after meaningful design choices, and before final completion. It is also instructed to use `AskUserQuestion` or the available user-input tool when scope, requirements, acceptance criteria, or direction are unclear.

For human-driven sessions, once the task is clear the primary worker is instructed to create or update `PLAN.md` and `status.md` before sustained implementation. At handoff or check-in time, the worker updates both files so the next session can resume from repo state instead of hidden chat context.

Each paired run gets a run id and a manifest under `~/.loop/runs/<repo-id>/<run-id>/`.

- Use `--run-id <id>` to resume a specific paired run.
- Use `--session <id>` to resolve an existing paired run from its run id, Claude session id, or Codex thread id.
- In single-agent mode, `--session <id>` still works as a raw Claude/Codex session resume flag.
- When combined with `--worktree` or `--tmux`, resumed paired runs keep the same run id so worktree and tmux naming stay aligned.

### Bridge delivery in tmux

In paired tmux mode, bridge delivery follows the visible workspace. If a live Codex pane is present, messages addressed to Codex are queued for the Codex tmux proxy, which injects them into that pane/thread. This keeps Claude->Codex review requests visible to the Codex reviewer instead of acknowledging them through a background app-server path that the reviewer TUI may not process.

If the stored tmux session is stale, `loop` clears the stale tmux routing and falls back to direct Codex app-server delivery when a valid Codex remote/thread is still available.

### Codex MCP isolation

Paired runs start loop-launched Codex with a run-scoped `CODEX_HOME` at:

```text
~/.loop/runs/<repo-id>/<run-id>/codex-home
```

That directory contains a minimal Codex config and reuses the normal Codex auth file. The loop bridge MCP is passed explicitly for the run, so global Codex MCP servers and plugin-provided app connectors are not started in paired loop sessions. This keeps autoloop and tmux startup deterministic even when the user's regular Codex config contains slow or broken MCP servers.

Single-agent Codex runs outside paired mode still use the normal Codex configuration unless you set `CODEX_HOME` yourself.

## Install globally (symlink)

```bash
bun run install:global
loop --help
```

This creates `loop`, `claude-loop`, and `codex-loop` in `~/.local/bin` on Unix, and `loop.exe` plus `claude-loop.cmd`/`codex-loop.cmd` on Windows.

If `loop` is not found, add this to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Then reload your shell:

```bash
source ~/.zshrc
```

## CI/CD

- CI runs on every push and pull request (`.github/workflows/ci.yml`)
- Releases run on every push to `main` (`.github/workflows/release.yml`)
- Release artifacts include compiled binaries for Linux, macOS (x64 + arm64), and Windows
- Release version comes from `package.json` (`v${version}`)
- If that tag already exists, release is skipped automatically

Example release:

```bash
# bump patch version and push commit + tag
bun run release:patch

# equivalent to:
# npm version patch && git push --follow-tags
```

## Auto-update

Prebuilt binaries check for updates automatically on startup and download new versions in the background. The update is applied on the next startup.

```bash
# manually check for updates
loop update

# same thing (alias)
loop upgrade
```

When running from source (`bun src/loop.ts`), auto-update is disabled — use `git pull` instead.

## Manual proxy reconnect E2E

For a real tmux + real Codex app-server reconnect check, run:

```bash
bun tests/loop/codex-tmux-proxy.manual.ts --model gpt-5.4-mini
```

This is a manual harness only. It is not part of `bun test`.
It restarts against a fresh Codex thread after the app-server drop.

## Options

- `claude-loop`: shorthand for `loop --claude-only`
- `codex-loop`: shorthand for `loop --codex-only`
- `dashboard`: open the live panel for active sessions, recent paired runs, and tmux sessions
- `-a, --agent <claude|codex|gemini|cursor|copilot>`: primary worker agent (default: `claude`)
- `--pair-with, --reviewer <claude|codex|gemini|cursor|copilot>`: live paired peer in paired mode. This is the agent that appears in the second tmux pane.
- `--claude-only`: use Claude for work, review, and plan review
- `--codex-only`: use Codex for work, review, and plan review
- `-p, --prompt <text|.md file>`: prompt text or a `.md` prompt file path. Plain text auto-creates `PLAN.md` first.
- `--proof <text>`: optional proof criteria for task completion
- `--codex-model <model>`: set the model passed to codex (`LOOP_CODEX_MODEL` can also set this by default)
- `--codex-reviewer-model <model>`: set the model used when Codex is acting as a reviewer. This applies to both `--review` and `--review-plan`, and falls back to `--codex-model` when omitted.
- `--claude-reviewer-model <model>`: set the model used when Claude is acting as a reviewer. This applies to both `--review` and `--review-plan`.
- `-m, --max-iterations <number>`: max loop count (default: `20`)
- `-d, --done <signal>`: done signal string (default: `<promise>DONE</promise>`)
- `--format <pretty|raw>`: output format (default: `pretty`)
- `--review [agent|claudex]`: choose completion reviewers for single-agent runs after the done signal (default: `claudex`; bare `--review` also uses `claudex`). In paired mode, the live peer from `--pair-with` is the completion reviewer. With `claudex`, both reviews run in parallel, then both comments are passed back to the original agent so it can decide what to address. If both reviews found the same issue, that is a stronger signal to fix it.
- `--review-plan [other|claude|codex|none]`: reviewer for the automatic plan review pass that runs after plain-text prompts create `PLAN.md` (default: `other`, the non-primary model). Use `none` to skip plan review.
- `--run-id <id>`: reuse a specific run id. In paired mode this resumes the stored run state and keeps tmux/worktree naming aligned to that id.
- `--session <id>`: resume from a paired run id or stored Claude/Codex session id. In single-agent mode, raw session/thread ids are passed through directly.
- `--tmux`: run `loop` in a detached tmux session so it survives SSH disconnects. In paired mode, Claude and Codex open side-by-side in the same tmux workspace. With no prompt and no proof, paired mode starts an interactive workspace and waits for the first task. Session name format: `repo-loop-X`
- `--worktree`: create and run inside a fresh git worktree + branch automatically. Resumed run ids re-enter or recreate the matching worktree when possible. Worktree/branch format: `repo-loop-X`
- `-h, --help`: help

## FAQ

### How do I use Codex as the main worker?

Use `--agent codex`.

### What happens when the two models disagree? And what's the point of pair programming if they both agree?

You might be surprised by how often a good model pushes back on comments. And if they both agree, that is in fact a strong signal. A model can make a mistake and catch it itself during the review -- if the other model also caught it, it is very likely a real issue. But they might both be wrong, so it is still useful to act as the human in the loop and steer when needed.

### Any benefits from doing the review locally compared to reviewing the GitHub PR?

It makes this feedback loop faster and more natural, while preserving context across iterations.

## Examples

```bash
# start paired interactive tmux workspace with no task yet
loop

# open the live dashboard explicitly
loop dashboard

# use PLAN.md automatically
loop --proof "Use {skill} to verify your changes"

# plain text prompt: auto-creates PLAN.md, then auto-reviews with the other model (default)
loop --proof "Use {skill} to verify your changes" "Implement {feature}"

# plain text prompt: skip automatic plan review
loop --proof "Use {skill} to verify your changes" --review-plan none "Implement {feature}"

# run with Codex as the worker and Claude as the live paired reviewer
loop --proof "Use {skill} to verify your changes" --agent codex --prompt PLAN.md

# run with Claude as the worker and Gemini as the live paired reviewer
loop --proof "Use {skill} to verify your changes" --agent claude --pair-with gemini --prompt PLAN.md

# single-agent mode: claude for work, review, and plan review
loop --claude-only --proof "Use {skill} to verify your changes" "Implement {feature}"

# single-agent mode: codex for work, review, and plan review
loop --codex-only --proof "Use {skill} to verify your changes" "Implement {feature}"

# shorthand commands
claude-loop --proof "Use {skill} to verify your changes" "Implement {feature}"
codex-loop --proof "Use {skill} to verify your changes" "Implement {feature}"

# run completion review with a single reviewer
loop --proof "Use {skill} to verify your changes" "Implement {feature}" --review codex

# use specific models only for reviewers
loop --proof "Use {skill} to verify your changes" "Implement {feature}" --codex-reviewer-model gpt-5.3-codex-spark --review claudex

# run claudex reviewers when done (default behavior)
loop --proof "Use {skill} to verify your changes" "Implement {feature}" --review claudex

# run in detached tmux session (good for SSH)
loop --tmux --proof "Use {skill} to verify your changes" "Implement {feature}"

# resume a paired run by run id
loop --run-id 7 --proof "Use {skill} to verify your changes"

# resume a paired run from a stored Claude session or Codex thread id
loop --session codex-thread-123 --proof "Use {skill} to verify your changes"

# run in a fresh git worktree automatically
loop --worktree --proof "Use {skill} to verify your changes" "Implement {feature}"

# run in detached tmux session in a fresh git worktree automatically
loop --tmux --worktree --proof "Use {skill} to verify your changes" "Implement {feature}"
```

## License

[MIT](LICENSE.md)
