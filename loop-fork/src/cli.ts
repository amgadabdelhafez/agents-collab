#!/usr/bin/env bun
import { isAgent } from "./loop/agents";
import { runBridgeMcpServer } from "./loop/bridge";
import {
  BRIDGE_SUBCOMMAND,
  BRIDGE_WORKER_SUBCOMMAND,
} from "./loop/bridge-constants";
import { runBridgeWorker } from "./loop/bridge-runtime";
import { closeClaudeSdk } from "./loop/claude-sdk-server";
import { closeAppServer } from "./loop/codex-app-server";
import {
  CODEX_TMUX_PROXY_SUBCOMMAND,
  runCodexTmuxProxy,
} from "./loop/codex-tmux-proxy";
import { cliDeps } from "./loop/deps";
import {
  GOVERNESS_SUBCOMMAND,
  resolveGovernessConfig,
  runGoverness,
} from "./loop/governess";
import { runGovernessUtilityCommand } from "./loop/governess-replay";
import { HOOK_EMIT_SUBCOMMAND, runHookEmit } from "./loop/hooks/emit";
import {
  LEGACY_GOVERNESS_SUBCOMMAND,
  withLegacyGovernessEnv,
} from "./loop/legacy-governess-compat";
import {
  RECON_PANE_SUBCOMMAND,
  type ReconPaneIndex,
  runReconPane,
} from "./loop/recon-pane";
import type { Agent, Options } from "./loop/types";
import { updateDeps } from "./loop/update-deps";
import {
  UTILITY_AU_PAIR_TIER,
  UTILITY_NANNY_TIER,
  type UtilityExecutionTierId,
} from "./loop/utility-execution-tier";
import {
  AU_PAIR_PANE_SUBCOMMAND,
  NANNY_PANE_SUBCOMMAND,
  runUtilityPane,
  runUtilityWorker,
  UTILITY_PANE_SUBCOMMAND,
  UTILITY_WORKER_SUBCOMMAND,
} from "./loop/utility-runtime";

const TMUX_DETACH_HINT = "[loop] detach with Ctrl-b d";
const DASHBOARD_COMMAND = "dashboard";
const DEFAULT_TMUX_ARGV = ["--tmux"];
const INTERACTIVE_TMUX_ERROR =
  "[loop] interactive paired tmux mode must be started outside tmux.";
const PAIRED_TMUX_HANDOFF_ERROR =
  "[loop] paired tmux launch did not hand off; not continuing in the foreground.";
const IMMEDIATE_INFO_FLAGS = new Set(["-h", "--help", "-v", "--version"]);

const isPromptlessPairedTmuxLaunch = (opts: Options): boolean =>
  Boolean(
    opts.tmux &&
      opts.pairedMode &&
      !opts.promptInput?.trim() &&
      !opts.proof.trim()
  );

const shouldAwaitAutoUpdate = (opts: Options): boolean =>
  !process.env.TMUX && isPromptlessPairedTmuxLaunch(opts);

const parseBridgeArgs = (
  argv: string[]
): { runDir: string; source: Agent | "supervisor" } => {
  const [runDir, source] = argv;
  if (!(runDir && (isAgent(source) || source === "supervisor"))) {
    throw new Error(
      "Usage: loop __bridge-mcp <run-dir> <claude|codex|gemini|cursor|copilot|supervisor>"
    );
  }
  return { runDir, source };
};

const parseBridgeWorkerArgs = (argv: string[]): { runDir: string } => {
  const [runDir] = argv;
  if (!runDir) {
    throw new Error("Usage: loop __bridge-worker <run-dir>");
  }
  return { runDir };
};

const parseUtilityWorkerArgs = (
  argv: string[]
): { epoch: number; jobId: string; runDir: string } => {
  const [runDir, rawEpoch, jobId] = argv;
  const epoch = Number.parseInt(rawEpoch ?? "", 10);
  if (!(runDir && Number.isInteger(epoch) && epoch > 0 && jobId)) {
    throw new Error("Usage: loop __utility-worker <run-dir> <epoch> <job-id>");
  }
  return { epoch, jobId, runDir };
};

const parseCodexTmuxProxyArgs = (
  argv: string[]
): { port: number; remoteUrl: string; runDir: string; threadId: string } => {
  const [runDir, remoteUrl, threadId, rawPort] = argv;
  const port = Number.parseInt(rawPort ?? "", 10);
  if (
    !(runDir && remoteUrl && threadId && Number.isInteger(port) && port > 0)
  ) {
    throw new Error(
      "Usage: loop __codex-tmux-proxy <run-dir> <remote-url> <thread-id> <port>"
    );
  }
  return { port, remoteUrl, runDir, threadId };
};

const utilityPaneTier = (
  subcommand: string | undefined
): UtilityExecutionTierId | undefined => {
  if (subcommand === NANNY_PANE_SUBCOMMAND) {
    return UTILITY_NANNY_TIER;
  }
  if (
    subcommand === AU_PAIR_PANE_SUBCOMMAND ||
    subcommand === UTILITY_PANE_SUBCOMMAND
  ) {
    return UTILITY_AU_PAIR_TIER;
  }
  return undefined;
};

const runReconPaneSubcommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== RECON_PANE_SUBCOMMAND) {
    return false;
  }
  const [runDir, rawIndex] = argv.slice(1);
  const index = Number.parseInt(rawIndex ?? "", 10) as ReconPaneIndex;
  if (!(runDir && (index === 1 || index === 2 || index === 3))) {
    throw new Error("Usage: loop __recon-pane <run-dir> <1|2|3>");
  }
  await runReconPane(runDir, index);
  return true;
};

// Dispatch the hidden `__*` helper subcommands. Returns true when handled.
const runHiddenSubcommand = async (argv: string[]): Promise<boolean> => {
  if (IMMEDIATE_INFO_FLAGS.has(argv[0] ?? "")) {
    // Version/help must never wait on startup maintenance or external tools.
    // parseArgs prints the requested text and exits in production; true keeps
    // this branch bounded under tests that replace process.exit.
    cliDeps.parseArgs(argv);
    return true;
  }
  if (await runReconPaneSubcommand(argv)) {
    return true;
  }
  if (argv[0] === BRIDGE_SUBCOMMAND) {
    const { runDir, source } = parseBridgeArgs(argv.slice(1));
    await runBridgeMcpServer(runDir, source);
    return true;
  }
  if (argv[0] === BRIDGE_WORKER_SUBCOMMAND) {
    const { runDir } = parseBridgeWorkerArgs(argv.slice(1));
    await runBridgeWorker(runDir);
    return true;
  }
  if (argv[0] === UTILITY_WORKER_SUBCOMMAND) {
    const { epoch, jobId, runDir } = parseUtilityWorkerArgs(argv.slice(1));
    await runUtilityWorker(runDir, epoch, jobId);
    return true;
  }
  const paneTier = utilityPaneTier(argv[0]);
  if (paneTier) {
    const [runDir] = argv.slice(1);
    if (!runDir) {
      throw new Error(`Usage: loop ${argv[0]} <run-dir>`);
    }
    await runUtilityPane(runDir, process.env, paneTier);
    return true;
  }
  if (argv[0] === CODEX_TMUX_PROXY_SUBCOMMAND) {
    const { port, remoteUrl, runDir, threadId } = parseCodexTmuxProxyArgs(
      argv.slice(1)
    );
    await runCodexTmuxProxy(runDir, remoteUrl, threadId, port);
    return true;
  }
  if (argv[0] === HOOK_EMIT_SUBCOMMAND) {
    const [source, hookFile, context] = argv.slice(1);
    if (
      !(
        isAgent(source) &&
        hookFile &&
        (context === undefined || context === "native-child")
      )
    ) {
      throw new Error(
        "Usage: loop __hook-emit <claude|codex|gemini|cursor|copilot> <hook-file> [native-child]"
      );
    }
    await runHookEmit(source, hookFile, {
      nativeChildContext: context === "native-child",
    });
    return true;
  }
  if (
    argv[0] === GOVERNESS_SUBCOMMAND ||
    argv[0] === LEGACY_GOVERNESS_SUBCOMMAND
  ) {
    const runId = argv[1];
    if (!runId) {
      throw new Error("Usage: loop __governess <run-id>");
    }
    await runGoverness(
      resolveGovernessConfig(runId, withLegacyGovernessEnv(process.env))
    );
    return true;
  }
  return false;
};

export const runCli = async (argv: string[]): Promise<void> => {
  if (runGovernessUtilityCommand(argv)) {
    return;
  }
  if (await runHiddenSubcommand(argv)) {
    return;
  }

  let shouldCloseAgents = true;
  try {
    const normalizedArgv = argv.length === 0 ? DEFAULT_TMUX_ARGV : argv;
    cliDeps.gcStaleClaudeBridgeRegistrations();
    await updateDeps.applyStagedUpdateOnStartup();
    if (await updateDeps.handleManualUpdateCommand(normalizedArgv)) {
      return;
    }

    if (process.env.TMUX) {
      console.log(TMUX_DETACH_HINT);
    }
    if (normalizedArgv[0]?.toLowerCase() === DASHBOARD_COMMAND) {
      updateDeps.startAutoUpdateCheck();
      await cliDeps.runPanel();
      return;
    }
    const opts = cliDeps.parseArgs(normalizedArgv);
    const awaitAutoUpdate = shouldAwaitAutoUpdate(opts);
    if (!awaitAutoUpdate) {
      updateDeps.startAutoUpdateCheck();
    }
    if (
      opts.tmux &&
      !opts.pairedMode &&
      (await cliDeps.runInTmux(normalizedArgv))
    ) {
      shouldCloseAgents = false;
      return;
    }
    const gitWarning = cliDeps.checkGitState();
    if (gitWarning) {
      console.log(gitWarning);
    }
    await cliDeps.maybeEnterWorktree(opts);
    if (awaitAutoUpdate) {
      await updateDeps.awaitAutoUpdateCheck();
    }
    if (isPromptlessPairedTmuxLaunch(opts)) {
      if (await cliDeps.runInTmux(normalizedArgv, undefined, { opts })) {
        shouldCloseAgents = false;
        return;
      }
      throw new Error(INTERACTIVE_TMUX_ERROR);
    }
    const task = await cliDeps.resolveTask(opts);
    if (opts.tmux && opts.pairedMode) {
      if (await cliDeps.runInTmux(normalizedArgv, undefined, { opts, task })) {
        shouldCloseAgents = false;
        return;
      }
      throw new Error(PAIRED_TMUX_HANDOFF_ERROR);
    }
    await cliDeps.runLoop(task, opts);
  } finally {
    if (shouldCloseAgents) {
      await Promise.all([closeAppServer(), closeClaudeSdk()]);
    }
  }
};

const main = async (): Promise<void> => {
  await runCli(process.argv.slice(2));
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loop] error: ${message}`);
    process.exit(1);
  });
}
