import { parseArgs, renderImmediateInfo } from "./args";
import { gcStaleClaudeBridgeRegistrations } from "./claude-config-gc";
import { checkGitState } from "./git";
import {
  bindLaunchTask,
  cancelPairedLaunch,
  reservePairedLaunch,
} from "./launch-reservation";
import { runLoop } from "./main";
import { runPanel } from "./panel";
import { gcAbandonedRunProcesses } from "./run-process-cleanup";
import { gcStaleBridgeProcesses } from "./stale-bridge-cleanup";
import { resolveTask } from "./task";
import { runInTmux } from "./tmux";
import { resolveWorkspaceBinding } from "./workspace-binding";
import { maybeEnterWorktree } from "./worktree";

export const cliDeps = {
  bindLaunchTask,
  cancelPairedLaunch,
  checkGitState,
  chdir: (path: string) => process.chdir(path),
  gcAbandonedRunProcesses,
  gcStaleBridgeProcesses,
  gcStaleClaudeBridgeRegistrations,
  maybeEnterWorktree,
  parseArgs,
  renderImmediateInfo,
  resolveTask,
  resolveWorkspaceBinding,
  reservePairedLaunch,
  runInTmux,
  runLoop,
  runPanel,
};
