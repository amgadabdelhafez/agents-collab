import { existsSync, readFileSync } from "node:fs";
import { spawn } from "bun";

const predecessor = JSON.parse(
  readFileSync(
    "/Users/amgad/.loop/runs/agents-collab-fa87e8608224/49/manifest.json",
    "utf8"
  )
);
if (
  !predecessor.workspaceReleasedAt ||
  existsSync("/Users/amgad/.loop/runs/agents-collab-fa87e8608224/50")
) {
  throw new Error("Single successor preflight refused");
}
const env = { ...process.env };
for (const key of [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "LOOP_RECIPIENT_API_TOKEN",
  "LOOP_CODEX_RECIPIENT_TOKEN",
  "LOOP_CLAUDE_RECIPIENT_TOKEN",
  "LOOP_RECIPIENT_ENROLLMENT_RUN_DIR",
  "LOOP_RECIPIENT_API_URL",
  "LOOP_VERTICAL_DATABASE_URL",
  "LOOP_VERTICAL_SUPERVISOR_TOKEN",
]) {
  delete env[key];
}
env.LOOP_TMUX_SOCKET = "/private/tmp/harness-vertical-cleanup-slice.sock";
env.LOOP_STARTUP_MAINTENANCE = "0";
const child = spawn(
  [
    "/private/tmp/harness-vertical-release-928bd1db",
    "--agent",
    "codex",
    "--pair-with",
    "claude",
    "--codex-model",
    "gpt-5.6-terra",
    "--effort-driver",
    "max",
    "--claude-reviewer-model",
    "sonnet",
    "--effort-reviewer",
    "low",
    "--workspace",
    "/private/tmp/harness-vertical-test-slice-1",
    "--tmux",
    "--review-plan",
    "none",
    "--prompt",
    "/private/tmp/harness-vertical-release-composition-v1/specs/harness-control-plane-vertical-release-v1/cleanup-charter.md",
  ],
  {
    cwd: "/Users/amgad/dev_projects/agents-collab",
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }
);
process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.exit(await child.exited);
