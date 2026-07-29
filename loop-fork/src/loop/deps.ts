import { parseArgs } from "./args";
import { gcStaleClaudeBridgeRegistrations } from "./claude-config-gc";
import { checkGitState } from "./git";
import { runLoop } from "./main";
import { runPanel } from "./panel";
import { gcAbandonedRunProcesses } from "./run-process-cleanup";
import { resolveTask } from "./task";
import { runInTmux } from "./tmux";
import { maybeEnterWorktree } from "./worktree";

export const cliDeps = {
  checkGitState,
  gcAbandonedRunProcesses,
  gcStaleClaudeBridgeRegistrations,
  maybeEnterWorktree,
  parseArgs,
  resolveTask,
  runInTmux,
  runLoop,
  runPanel,
};
