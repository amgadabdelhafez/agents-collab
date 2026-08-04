import pkg from "../../package.json";
import { DEFAULT_CAVEMAN_MODE, DEFAULT_HELPER_CAVEMAN_MODE } from "./caveman";
import { DEFAULT_LAUNCH_EFFORT } from "./effort";
import type { ValueFlag } from "./types";

export const DEFAULT_DONE_SIGNAL = "<promise>DONE</promise>";
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_CODEX_REASONING_EFFORT = DEFAULT_LAUNCH_EFFORT;
export const DEFAULT_CODEX_SERVICE_TIER = "standard";
export const DEFAULT_CODEX_CONFIG_VALUES = [
  `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`,
  `service_tier="${DEFAULT_CODEX_SERVICE_TIER}"`,
] as const;
export const DEFAULT_CLAUDE_MODEL = "opus";
// Tmux DRIVER only — the headless SDK/judge legs stay at their own defaults.
export const DEFAULT_CLAUDE_DRIVER_EFFORT = DEFAULT_LAUNCH_EFFORT;
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-pro";
export const DEFAULT_COPILOT_MODEL = "auto";
export const DEFAULT_CURSOR_MODEL = "auto";
export const DEFAULT_MAX_ITERATIONS = 20;
export const LOOP_VERSION = pkg.version;

// Governess pane (--governess) defaults.
export const DEFAULT_GOVERNESS_IDLE_SECONDS = 120;
export const DEFAULT_GOVERNESS_COOLDOWN_SECONDS = 300;
export const DEFAULT_GOVERNESS_MAX_RECOVERIES = 3;
export const DEFAULT_GOVERNESS_URL = "http://127.0.0.1:8082";
export const DEFAULT_GOVERNESS_MODEL = "mlx-community/Qwen3.6-35B-A3B-4bit";
export const DEFAULT_GOVERNESS_HEIGHT = "40%";
export const DEFAULT_GOVERNESS_CONFIDENCE = 0.7;
export const DEFAULT_GOVERNESS_TICK_SECONDS = 15;
export const DEFAULT_GOVERNESS_ESCALATE_IDLE_SECONDS = 300;
export const DEFAULT_USAGE_TRACKER_URL = "http://127.0.0.1:8000";
export const DEFAULT_USAGE_TRACKER_TIMEOUT_MS = 1500;

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
  --effort <low|medium|high|xhigh|max>      Set driver and reviewer effort (default: ${DEFAULT_LAUNCH_EFFORT})
  --effort-driver <level>                  Set only the primary driver effort
  --effort-reviewer <level>                Set only the paired reviewer effort
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
  --caveman <off|lite|full|ultra>          Main-agent output compression (default: ${DEFAULT_CAVEMAN_MODE})
  --helper-caveman <off|lite|full|ultra>   Nanny/Au Pair output compression (default: ${DEFAULT_HELPER_CAVEMAN_MODE})
  --format <pretty|raw>                    Log format (default: pretty)
  --review [agent|claudex]                 Single-agent completion review mode (default: claudex)
  --review-plan [other|agent|none]         Review PLAN.md after plain-text planning (default: other)
  --run-id <id>                            Reuse a specific run id; resumes paired runs in paired mode when supported
  --session <id>                           Resume from a paired run id or raw session/thread ID
  --tmux                                   Run in tmux (paired mode opens the selected two agents side-by-side; no prompt/proof starts interactive sessions)
  --workspace <path>                       Run in and bind to an existing registered Git worktree
  --worktree                               Create and run in a fresh git worktree (name: repo-loop-X)
  --governess                                Compatibility flag; governess is always enabled for paired tmux runs
  --governess-dry-run                        Governess logs intended recovery actions but executes none
  --governess-idle <seconds>                 Idle seconds before an agent is a stuck suspect (default: ${DEFAULT_GOVERNESS_IDLE_SECONDS})
  --governess-cooldown <seconds>             Minimum seconds between recovery actions per agent (default: ${DEFAULT_GOVERNESS_COOLDOWN_SECONDS})
  --governess-max-recoveries <number>        Max recovery actions per agent per run (default: ${DEFAULT_GOVERNESS_MAX_RECOVERIES})
  --governess-url <url>                      OpenAI-compatible endpoint for governess judgment (default: ${DEFAULT_GOVERNESS_URL})
  --governess-model <model>                  Model id for governess judgment (default: ${DEFAULT_GOVERNESS_MODEL})
  --governess-height <rows|percent>          Governess pane height, e.g. 25% or 12 (default: ${DEFAULT_GOVERNESS_HEIGHT})
  governess doctor <run-id>                  Check governess state, journal, epoch, and tmux readiness
  governess replay <run-id>                  Replay the durable governess control journal and report invariant violations
  governess explain <run-id> [control-id]    Explain policy, transport, evidence, and phase history for a control
  -v, --version                            Show loop version
  -h, --help                               Show this help

Environment:
  LOOP_GOVERNESS_JUDGES=<spec>               Multi-judge list: id=url,model[,logFile];id2=url,model[,logFile]
  LOOP_GOVERNESS_JUDGE_MODE=<mode>           Local judge policy: consensus or round-robin (default: consensus)
  LOOP_GOVERNESS_AGENT_RENAME=1              Legacy opt-in for guarded /rename; pane-border task labels are preferred
  LOOP_GOVERNESS_ROLE_BALANCE=1              Enable proactive driver switching based on quota headroom (default: off)
  LOOP_GOVERNESS_LLM_TRACE=1                 Trace local LLM request/response JSONL to the run's llm-trace.jsonl
  LOOP_GOVERNESS_LLM_LOG=<path>              Read MLX prompt-cache metrics from a custom server log path
  LOOP_AU_PAIR_API_KEY_FILE=<path>           Au Pair key file (default: ~/.config/loop/openrouter.key; requires mode 0600)
  LOOP_AU_PAIR_ENABLED=0|1                   Disable or explicitly enable Au Pair
  LOOP_AU_PAIR_URL=<url>                     Au Pair (GLM) OpenAI-compatible endpoint
  LOOP_AU_PAIR_MODEL=<model>                 Au Pair model (default: z-ai/glm-5.2)
  LOOP_AU_PAIR_MAX_CONCURRENCY=<1..8>        Concurrent Au Pair slots (default: 4)
  LOOP_AU_PAIR_PROVIDER_SORT=<strategy>      balanced, price, throughput, latency, or tool-call-quality
  LOOP_NANNY_ENABLED=0|1                     Disable or explicitly enable Nanny
  LOOP_NANNY_URL=<url>                       Nanny local Pi endpoint (default: 127.0.0.1:8082)
  LOOP_NANNY_MODEL=<model>                   Nanny local Qwen model
  LOOP_NANNY_MAX_CONCURRENCY=<1..2>          Concurrent Nanny slots (default: 1)
  LOOP_CAVEMAN_MODE=<mode>                    Main-agent Caveman mode: off, lite, full, or ultra
  LOOP_HELPER_CAVEMAN_MODE=<mode>             Nanny/Au Pair Caveman mode: off, lite, full, or ultra
  LOOP_EFFORT=<level>                          Driver and reviewer effort fallback
  LOOP_DRIVER_EFFORT=<level>                   Driver effort fallback; overrides LOOP_EFFORT
  LOOP_REVIEWER_EFFORT=<level>                 Reviewer effort fallback; overrides LOOP_EFFORT
                                               Precedence per role: role CLI, global CLI, role env, global env, default
  LOOP_UTILITY_HARNESS=pi-sdk|legacy         Helper harness (default: pi-sdk)
  LOOP_UTILITY_PANE=0                        Hide the default Nanny and Au Pair pane column
  LOOP_UTILITY_PANE_WIDTH=<columns|percent>  Nanny and Au Pair column width (default: 20%)
  LOOP_UTILITY_PANE_HEIGHT=<columns|percent> Deprecated alias for LOOP_UTILITY_PANE_WIDTH
  LOOP_UTILITY_DELEGATION_MODE=<mode>        enforce (default), observe, or off for mechanical task adoption
  LOOP_UTILITY_COST_QUALITY=<0..10>          Workspace cost/quality preference (default: 7)
  LOOP_UTILITY_ALLOWED_TIERS=<patterns>      Comma-separated tier wildcard allowlist
  LOOP_USAGE_TRACKER_URL=<url>             Usage Tracker API URL for governess RL limits (default: ${DEFAULT_USAGE_TRACKER_URL})
  LOOP_USAGE_TRACKER_SECRET=<secret>        Bearer token for Usage Tracker /stats (falls back to USAGE_TRACKER_SECRET)

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
  "--effort": "effort",
  "--effort-driver": "driverEffort",
  "--effort-reviewer": "reviewerEffort",
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
  "--governess-idle": "governessIdle",
  "--governess-cooldown": "governessCooldown",
  "--governess-max-recoveries": "governessMaxRecoveries",
  "--governess-url": "governessUrl",
  "--governess-model": "governessModel",
  "--governess-height": "governessHeight",
  "--caveman": "cavemanMode",
  "--helper-caveman": "helperCavemanMode",
};
