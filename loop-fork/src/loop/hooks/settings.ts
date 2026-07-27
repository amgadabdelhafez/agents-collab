import type { Agent } from "../types";
import { CLAUDE_HOOK_EVENTS, CODEX_HOOK_EVENTS } from "./emit";

// A single hook entry in Claude/Codex settings ("command" hooks read the event
// payload on stdin, so one command serves every event).
interface HookCommand {
  command: string;
  type: "command";
}

interface HookMatcher {
  hooks: HookCommand[];
}

export interface HookConfig {
  hooks: Record<string, HookMatcher[]>;
}

const quoteArg = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

// Build the shell command an agent hook runs: `<loop bin...> __hook-emit <agent> <file>`.
export const buildHookCommand = (
  launchArgv: string[],
  agent: Agent,
  hookFile: string
): string =>
  [...launchArgv, "__hook-emit", agent, hookFile].map(quoteArg).join(" ");

const buildHookConfig = (
  events: readonly string[],
  command: string
): HookConfig => ({
  hooks: Object.fromEntries(
    events.map((event) => [event, [{ hooks: [{ type: "command", command }] }]])
  ),
});

// Claude reads this via `--settings <file>`; registers per-tool + turn events.
export const buildClaudeHookSettings = (command: string): HookConfig =>
  buildHookConfig(CLAUDE_HOOK_EVENTS, command);

// Codex reads this from `$CODEX_HOME/hooks.json`; only coarse turn events exist.
export const buildCodexHooksJson = (command: string): HookConfig =>
  buildHookConfig(CODEX_HOOK_EVENTS, command);
