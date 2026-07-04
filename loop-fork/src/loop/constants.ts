import pkg from "../../package.json";
import type { ValueFlag } from "./types";

export const DEFAULT_DONE_SIGNAL = "<promise>DONE</promise>";
export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_CLAUDE_MODEL = "opus";
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
export const DEFAULT_COPILOT_MODEL = "auto";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_MAX_ITERATIONS = 20;
export const LOOP_VERSION = pkg.version;

// Babysitter pane (--babysit) defaults.
export const DEFAULT_BABYSIT_IDLE_SECONDS = 120;
export const DEFAULT_BABYSIT_COOLDOWN_SECONDS = 300;
export const DEFAULT_BABYSIT_MAX_RECOVERIES = 3;
export const DEFAULT_BABYSIT_URL = "http://127.0.0.1:8082";
export const DEFAULT_BABYSIT_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit";
export const DEFAULT_BABYSIT_HEIGHT = "25%";
export const DEFAULT_BABYSIT_CONFIDENCE = 0.7;

export const HELP = `
loop - v${LOOP_VERSION} - meta agent loop runner

Usage:
  loop                                     Start paired interactive tmux mode
  loop dashboard                           Open live panel for running loop instances
  loop [options] [prompt]
  loop update                              Check for updates and apply if available
  loop upgrade                             Alias for update
  claude-loop [options] [prompt]           Alias for: loop --claude-only
  codex-loop [options] [prompt]            Alias for: loop --codex-only
  gemini-loop [options] [prompt]           Alias for: loop --gemini-only
  cursor-loop [options] [prompt]           Alias for: loop --cursor-only
  copilot-loop [options] [prompt]          Alias for: loop --copilot-only

Options:
  -a, --agent <agent>                     Agent CLI to run (default: claude)
  --claude-only                            Use Claude for work, review, and plan review
  --codex-only                             Use Codex for work, review, and plan review
  --gemini-only                            Use Gemini for work, review, and plan review
  --cursor-only                            Use Cursor for work, review, and plan review
  --copilot-only                           Use Copilot for work, review, and plan review
  --pair-with, --reviewer <agent>          Pair the worker with a specific peer in paired mode
  -p, --prompt <text|.md file>             Prompt text or path to a .md prompt file
  -m, --max-iterations <number>            Max loops (default: ${DEFAULT_MAX_ITERATIONS})
  -d, --done <signal>                      Done signal (default: <promise>DONE</promise>)
  --proof <text>                           Proof requirements for task completion
  --codex-model <model>                    Override codex model (default: ${DEFAULT_CODEX_MODEL})
  --codex-reviewer-model <model>           Override codex review model
  --gemini-model <model>                   Override gemini model (default: ${DEFAULT_GEMINI_MODEL})
  --gemini-reviewer-model <model>          Override gemini review model
  --copilot-model <model>                  Override copilot model (default: ${DEFAULT_COPILOT_MODEL})
  --copilot-reviewer-model <model>         Override copilot review model
  --cursor-model <model>                   Override cursor model (default: ${DEFAULT_CURSOR_MODEL})
  --cursor-reviewer-model <model>          Override cursor review model
  --claude-reviewer-model <model>          Override claude review model
  --format <pretty|raw>                    Log format (default: pretty)
  --review [agent|claudex]                 Single-agent completion review mode (default: claudex)
  --review-plan [other|agent|none]         Review PLAN.md after plain-text planning (default: other)
  --run-id <id>                            Reuse a specific run id; resumes paired runs in paired mode when supported
  --session <id>                           Resume from a paired run id or raw session/thread ID
  --tmux                                   Run in tmux (paired mode opens the selected two agents side-by-side; no prompt/proof starts interactive sessions)
  --worktree                               Create and run in a fresh git worktree (name: repo-loop-X)
  --babysit                                Add a full-width bottom pane that summarizes both agents from their hook events and auto-recovers a stuck agent (paired + tmux only)
  --babysit-dry-run                        Babysitter logs intended recovery actions but executes none
  --babysit-idle <seconds>                 Idle seconds before an agent is a stuck suspect (default: ${DEFAULT_BABYSIT_IDLE_SECONDS})
  --babysit-cooldown <seconds>             Minimum seconds between recovery actions per agent (default: ${DEFAULT_BABYSIT_COOLDOWN_SECONDS})
  --babysit-max-recoveries <number>        Max recovery actions per agent per run (default: ${DEFAULT_BABYSIT_MAX_RECOVERIES})
  --babysit-url <url>                      OpenAI-compatible endpoint for babysitter judgment (default: ${DEFAULT_BABYSIT_URL})
  --babysit-model <model>                  Model id for babysitter judgment (default: ${DEFAULT_BABYSIT_MODEL})
  --babysit-height <rows|percent>          Babysitter pane height, e.g. 25% or 12 (default: ${DEFAULT_BABYSIT_HEIGHT})
  -v, --version                            Show loop version
  -h, --help                               Show this help

Auto-update:
  Updates are checked automatically on startup and applied on the next run.
  Use "loop update" to manually check and apply an update.
`.trim();

export const REVIEW_PASS = "<review>PASS</review>";
export const REVIEW_FAIL = "<review>FAIL</review>";
export const AGENT_TURN_TIMEOUT_MS = 42_000_069;
export const NEWLINE_RE = /\r?\n/;

export const VALUE_FLAGS: Record<string, ValueFlag> = {
  "-a": "agent",
  "--agent": "agent",
  "-p": "prompt",
  "--prompt": "prompt",
  "-m": "max",
  "--max-iterations": "max",
  "-d": "done",
  "--done": "done",
  "--proof": "proof",
  "--pair-with": "pairWith",
  "--reviewer": "pairWith",
  "--codex-model": "codexModel",
  "--codex-reviewer-model": "codexReviewerModel",
  "--copilot-model": "copilotModel",
  "--copilot-reviewer-model": "copilotReviewerModel",
  "--cursor-model": "cursorModel",
  "--cursor-reviewer-model": "cursorReviewerModel",
  "--claude-reviewer-model": "claudeReviewerModel",
  "--gemini-model": "geminiModel",
  "--gemini-reviewer-model": "geminiReviewerModel",
  "--format": "format",
  "--run-id": "runId",
  "--session": "session",
  "--babysit-idle": "babysitIdle",
  "--babysit-cooldown": "babysitCooldown",
  "--babysit-max-recoveries": "babysitMaxRecoveries",
  "--babysit-url": "babysitUrl",
  "--babysit-model": "babysitModel",
  "--babysit-height": "babysitHeight",
};
