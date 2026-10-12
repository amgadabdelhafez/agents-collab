#!/usr/bin/env bun
import { spawn as spawnChild } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  describeA2AClientFailure,
  describeA2ALeaseRelease,
  releaseRecordedA2ALease,
} from "./loop/a2a-session-client";
import {
  A2A_COMMAND,
  extractA2AAsFlag,
  runA2ACommand,
} from "./loop/a2a-session-command";
import { isAgent } from "./loop/agents";
import { findImmediateInfoRequest } from "./loop/args";
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
import { CONNECT_COMMAND, runConnectCommand } from "./loop/connect-command";
import { RECONCILE_USAGE } from "./loop/constants";
import { cliDeps } from "./loop/deps";
import {
  GOVERNESS_SUBCOMMAND,
  resolveGovernessConfig,
  runGoverness,
} from "./loop/governess";
import { runGovernessCostCommand } from "./loop/governess-cost";
import {
  GOVERNESS_PANE_DIED_SUBCOMMAND,
  handleGovernessPaneDied,
  parseGovernessPaneDiedArgs,
} from "./loop/governess-pane-liveness";
import { runGovernessUtilityCommand } from "./loop/governess-replay";
import {
  AGENT_SECURE_SUBCOMMAND,
  consumeGovernessEnvironmentFile,
  GOVERNESS_SECURE_SUBCOMMAND,
} from "./loop/governess-secure-env";
import { HOOK_EMIT_SUBCOMMAND, runHookEmit } from "./loop/hooks/emit";
import type { PairedLaunchClaim } from "./loop/launch-reservation";
import { tmuxRuntimeAbsentForManifest } from "./loop/launch-reservation";
import {
  LEGACY_GOVERNESS_SUBCOMMAND,
  withLegacyGovernessEnv,
} from "./loop/legacy-governess-compat";
import {
  MAILBOX_COMMAND,
  runMailboxCommandWithV2Ack,
} from "./loop/mailbox-command";
import { runMailboxSweep } from "./loop/mailbox-sweep";
import {
  MEMORY_PROMOTE_SUBCOMMAND,
  promoteMemoryCheckpoint,
} from "./loop/memory-checkpoint";
import { runOrchestrationCommand } from "./loop/orchestration-command";
import {
  defaultPidOwnershipDeps,
  pidCanStillOwnRun,
} from "./loop/pid-ownership";
import { groupCanStillOwnRun } from "./loop/process-group";
import { runProjectCommand } from "./loop/project-command";
import {
  RECON_PANE_SUBCOMMAND,
  type ReconPaneIndex,
  runReconPane,
} from "./loop/recon-pane";
import { reconcileLegacyStoppedRun, resolveRunStorage } from "./loop/run-state";
import { runStopCommand } from "./loop/run-stop";
import {
  defaultOwnershipProbes,
  recordedProcessClassifier,
} from "./loop/shared-process-ownership";
import { runTokenCommand, TOKEN_COMMAND } from "./loop/token-code-command";
import type { Agent, Options } from "./loop/types";
import { updateDeps } from "./loop/update-deps";
import { UTILITY_WORKER_SUBCOMMAND } from "./loop/utility-constants";
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
} from "./loop/utility-runtime";
import { runWorldCommand } from "./loop/world-model-cli";

const TMUX_DETACH_HINT = "[loop] detach with Ctrl-b d";
const DASHBOARD_COMMAND = "dashboard";
const DEFAULT_TMUX_ARGV = ["--tmux"];
const INTERACTIVE_TMUX_ERROR =
  "[loop] interactive paired tmux mode must be started outside tmux.";
const PAIRED_TMUX_HANDOFF_ERROR =
  "[loop] paired tmux launch did not hand off; not continuing in the foreground.";
const MARKDOWN_PATH_RE = /\.md$/iu;
const CANONICAL_POSITIVE_RUN_ID_RE = /^[1-9]\d*$/u;

const isPromptlessPairedTmuxLaunch = (opts: Options): boolean =>
  Boolean(
    opts.tmux &&
      opts.pairedMode &&
      !opts.promptInput?.trim() &&
      !opts.proof.trim()
  );

const shouldAwaitAutoUpdate = (opts: Options): boolean =>
  !process.env.TMUX && isPromptlessPairedTmuxLaunch(opts);

const preserveRelativePromptPath = (
  opts: Options,
  invocationCwd: string
): void => {
  const input = opts.promptInput?.trim();
  if (!(input && MARKDOWN_PATH_RE.test(input) && !isAbsolute(input))) {
    return;
  }
  opts.promptInput = resolve(invocationCwd, input);
};

const parseBridgeArgs = (
  argv: string[]
): { runDir: string; source: Agent | "supervisor" } => {
  const [runDir, source] = argv;
  if (!(runDir && (isAgent(source) || source === "supervisor"))) {
    throw new Error(
      "Usage: loop __bridge-mcp <run-dir> <claude|codex|oss|supervisor>"
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

const runMemoryPromoteSubcommand = (argv: string[]): boolean => {
  if (argv[0] !== MEMORY_PROMOTE_SUBCOMMAND) {
    return false;
  }
  const [checkpointPath, promotionClass, outputDir, title, curator, bodyFile] =
    argv.slice(1);
  if (
    !(
      checkpointPath &&
      promotionClass &&
      outputDir &&
      title &&
      curator &&
      bodyFile
    )
  ) {
    throw new Error(
      "Usage: loop __memory-promote <checkpoint> <class> <output-dir> <title> <curator> <body-file>"
    );
  }
  const promotion = promoteMemoryCheckpoint({
    body: readFileSync(bodyFile, "utf8"),
    checkpointPath,
    class: promotionClass,
    curator,
    outputDir,
    title,
  });
  process.stdout.write(`${JSON.stringify(promotion)}\n`);
  return true;
};

const runSecureGovernessSubcommand = async (
  argv: string[]
): Promise<boolean> => {
  if (argv[0] !== GOVERNESS_SECURE_SUBCOMMAND) {
    return false;
  }
  const [runId, environmentPath] = argv.slice(1);
  if (!(runId && environmentPath)) {
    throw new Error(
      "Usage: loop __governess-secure <run-id> <environment-path>"
    );
  }
  Object.assign(process.env, consumeGovernessEnvironmentFile(environmentPath));
  await runGoverness(
    resolveGovernessConfig(runId, withLegacyGovernessEnv(process.env))
  );
  return true;
};

const runSecureAgentSubcommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== AGENT_SECURE_SUBCOMMAND) {
    return false;
  }
  const [environmentPath, command, ...args] = argv.slice(1);
  if (!(environmentPath && command)) {
    throw new Error(
      "Usage: loop __agent-secure <environment-path> <command> [args...]"
    );
  }
  const child = spawnChild(command, args, {
    env: {
      ...process.env,
      ...consumeGovernessEnvironmentFile(environmentPath),
    },
    stdio: "inherit",
  });
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const onInterrupt = (): void => forward("SIGINT");
  const onTerminate = (): void => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve(code ?? (signal ? 128 : 1));
      });
    });
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  return true;
};

// Dispatch the hidden `__*` helper subcommands. Returns true when handled.
const runHiddenSubcommand = async (argv: string[]): Promise<boolean> => {
  if (runMemoryPromoteSubcommand(argv)) {
    return true;
  }
  if (argv[0] === GOVERNESS_PANE_DIED_SUBCOMMAND) {
    handleGovernessPaneDied(parseGovernessPaneDiedArgs(argv.slice(1)));
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
        "Usage: loop __hook-emit <claude|codex|oss> <hook-file> [native-child]"
      );
    }
    await runHookEmit(source, hookFile, {
      nativeChildContext: context === "native-child",
    });
    return true;
  }
  if (await runSecureGovernessSubcommand(argv)) {
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

const runImmediateInfoCommand = (argv: string[]): boolean => {
  const request = findImmediateInfoRequest(argv);
  if (!request) {
    return false;
  }
  // Rendering is config-independent and exits in production; true keeps this
  // bounded when tests replace process.exit or the renderer dependency.
  cliDeps.renderImmediateInfo(request);
  return true;
};

const runStoppedRunReconcileCommand = async (
  argv: string[]
): Promise<boolean> => {
  if (argv[0] !== "reconcile") {
    return false;
  }
  const [kind, runId, ...extra] = argv.slice(1);
  if (
    (kind !== "stopped-run" &&
      kind !== "failed-start" &&
      kind !== "failed-terminal") ||
    !runId ||
    extra.length > 0 ||
    !CANONICAL_POSITIVE_RUN_ID_RE.test(runId)
  ) {
    throw new Error(`Usage: ${RECONCILE_USAGE}`);
  }
  const storage = resolveRunStorage(runId);
  const result = await reconcileLegacyStoppedRun(storage.manifestPath, runId, {
    terminalState: kind === "stopped-run" ? "stopped" : "failed",
    // A live process another live run holds too (or a daemon that re-parented
    // away outside the workspace) keeps the workspace only while it works in
    // it (see `shared-process-ownership`).
    classifyRecordedProcess: recordedProcessClassifier(defaultOwnershipProbes),
    // A utility worker's or agent pane's process group is live while any
    // member exists, after its leader is gone.
    groupCanStillOwnRun: (pgid, reference) =>
      groupCanStillOwnRun(pgid, reference, defaultPidOwnershipDeps),
    now: () => new Date().toISOString(),
    pidCanStillOwnRun: (pid, stoppedAt) =>
      pidCanStillOwnRun(pid, stoppedAt, {
        ...defaultPidOwnershipDeps,
      }),
    // The same rule as the launch scan: the recorded socket, or for a legacy
    // manifest with no socket, every socket the launcher could have used.
    runtimeAbsent: (manifestPath) => tmuxRuntimeAbsentForManifest(manifestPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "refused") {
    throw new Error(`${kind} reconciliation refused: ${result.reason}`);
  }
  const closed = await cliDeps.closeGovernessBeatForTerminalRun({
    env: process.env,
    manifestPath: storage.manifestPath,
    reason: `reconcile ${kind}`,
    runId,
  });
  for (const one of closed?.legacy ? [closed, closed.legacy] : [closed]) {
    if (one) {
      console.error(
        `[loop] ${one.workflowId}: ${one.outcome}${one.detail ? ` (${one.detail})` : ""}`
      );
    }
  }
  // A reconciled run serves no supervisor: hand its A2A endpoint back. Never
  // throws; a failed release lapses by the lease TTL.
  const a2aRelease = describeA2ALeaseRelease(
    await releaseRecordedA2ALease(storage.runDir)
  );
  if (a2aRelease) {
    console.error(a2aRelease);
  }
  return true;
};

const runMailboxCliCommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== MAILBOX_COMMAND) {
    return false;
  }
  const result =
    argv[1] === "sweep"
      ? runMailboxSweep(argv)
      : await runMailboxCommandWithV2Ack(argv);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const deferred = "v2" in result ? result.v2?.deferred : undefined;
  if (deferred && deferred.length > 0) {
    console.error(
      `[loop] ${deferred.length} V2 message(s) acknowledged in the mailbox cursor only (${deferred[0]?.reason}); the orchestration server records the recipient ACK from the cursor`
    );
  }
  const held = "heldKeys" in result ? result.heldKeys : undefined;
  if (held && held.length > 0) {
    throw new Error(
      `the recipient route did not acknowledge ${held.length} V2 message(s); they stay unread: ${held.join(", ")}`
    );
  }
  return true;
};

const runA2ACliCommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== A2A_COMMAND) {
    return false;
  }
  let result: Record<string, unknown>;
  try {
    result = await runA2ACommand(argv);
  } catch (error) {
    // A client refusal's safe underlying cause (no token, no headers), so a
    // refused send is diagnosable from the CLI alone.
    throw new Error(describeA2AClientFailure(error));
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return true;
};

const runProjectCliCommand = (argv: string[]): boolean => {
  const result = runProjectCommand(argv);
  if (!result) {
    return false;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return true;
};

/**
 * `loop connect`: an MCP server on stdio (stdout is the protocol channel, so
 * nothing else is printed there). A fenced or refused stream exits non-zero.
 */
const runConnectCliCommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== CONNECT_COMMAND) {
    return false;
  }
  const { end } = await runConnectCommand(argv);
  if (end.reason === "fenced" || end.reason === "refused") {
    throw new Error(`loop connect: inbox stream ${end.reason} (${end.detail})`);
  }
  return true;
};

/**
 * `loop token code`: mint an enrollment code through the server's owner
 * route. Lines name who it is for, the file and the expiry, never the code.
 */
const runTokenCliCommand = async (argv: string[]): Promise<boolean> => {
  if (argv[0] !== TOKEN_COMMAND) {
    return false;
  }
  for (const line of await runTokenCommand(argv)) {
    process.stdout.write(`${line}\n`);
  }
  return true;
};

const runPreMaintenanceCommand = async (argv: string[]): Promise<boolean> =>
  runProjectCliCommand(argv) ||
  (await runMailboxCliCommand(argv)) ||
  (await runA2ACliCommand(argv)) ||
  (await runConnectCliCommand(argv)) ||
  (await runTokenCliCommand(argv)) ||
  (await runOrchestrationCommand(argv)) ||
  (await runStoppedRunReconcileCommand(argv)) ||
  (await runStopCommand(argv)) ||
  (await runSecureAgentSubcommand(argv)) ||
  runWorldCommand(argv) ||
  runImmediateInfoCommand(argv) ||
  (await runGovernessCostCommand(argv)) ||
  runGovernessUtilityCommand(argv) ||
  (await runHiddenSubcommand(argv));

interface PreparedCliLaunch {
  /** `--a2a-as supervisor:x`: claim the run's A2A V2 endpoint once started. */
  a2aAs?: string;
  awaitAutoUpdate: boolean;
  launchClaim?: PairedLaunchClaim;
  opts: Options;
  outerTmuxHandedOff: boolean;
}

const enterExplicitWorkspace = (opts: Options, invocationCwd: string): void => {
  if (!opts.workspace) {
    return;
  }
  const binding = cliDeps.resolveWorkspaceBinding(
    opts.workspace,
    invocationCwd
  );
  cliDeps.chdir(binding.root);
  opts.workspaceBinding = binding;
};

const prepareCliLaunch = async (
  normalizedArgv: string[],
  invocationCwd: string,
  a2aAs?: string
): Promise<PreparedCliLaunch> => {
  const opts = cliDeps.parseArgs(normalizedArgv);
  if (a2aAs && !(opts.tmux && opts.pairedMode)) {
    throw new Error(
      "[loop] --a2a-as needs a paired tmux launch: only a run with its own session ids can serve a supervisor."
    );
  }
  preserveRelativePromptPath(opts, invocationCwd);
  enterExplicitWorkspace(opts, invocationCwd);
  const awaitAutoUpdate = shouldAwaitAutoUpdate(opts);
  if (!awaitAutoUpdate) {
    updateDeps.startAutoUpdateCheck();
  }
  if (
    opts.tmux &&
    !opts.pairedMode &&
    (await cliDeps.runInTmux(normalizedArgv))
  ) {
    return { awaitAutoUpdate, opts, outerTmuxHandedOff: true };
  }
  const gitWarning = cliDeps.checkGitState();
  if (gitWarning) {
    console.log(gitWarning);
  }
  await cliDeps.maybeEnterWorktree(opts);

  let launchClaim: PairedLaunchClaim | undefined;
  try {
    if (opts.tmux && opts.pairedMode) {
      const binding =
        opts.workspaceBinding ??
        cliDeps.resolveWorkspaceBinding(undefined, process.cwd());
      opts.workspaceBinding = binding;
      launchClaim = await cliDeps.reservePairedLaunch(opts, binding);
      if (process.cwd() !== launchClaim.workspaceBinding.root) {
        cliDeps.chdir(launchClaim.workspaceBinding.root);
      }
    }
    return {
      ...(a2aAs ? { a2aAs } : {}),
      awaitAutoUpdate,
      ...(launchClaim ? { launchClaim } : {}),
      opts,
      outerTmuxHandedOff: false,
    };
  } catch (error) {
    if (launchClaim) {
      cliDeps.cancelPairedLaunch(launchClaim);
    }
    throw error;
  }
};

const a2aLaunchField = (a2aAs?: string): { a2aAs?: string } =>
  a2aAs ? { a2aAs } : {};

const executePreparedLaunch = async (
  normalizedArgv: string[],
  prepared: PreparedCliLaunch
): Promise<boolean> => {
  const { a2aAs, awaitAutoUpdate, launchClaim, opts } = prepared;
  if (awaitAutoUpdate) {
    await updateDeps.awaitAutoUpdateCheck();
  }
  if (isPromptlessPairedTmuxLaunch(opts)) {
    if (!launchClaim) {
      throw new Error("[loop] paired tmux launch has no run reservation");
    }
    if (launchClaim.reserved) {
      await cliDeps.prepareRunWorldModel(launchClaim);
    }
    if (
      await cliDeps.runInTmux(normalizedArgv, undefined, {
        ...a2aLaunchField(a2aAs),
        opts,
      })
    ) {
      return true;
    }
    throw new Error(INTERACTIVE_TMUX_ERROR);
  }
  const task = await cliDeps.resolveTask(opts);
  if (launchClaim) {
    cliDeps.bindLaunchTask(launchClaim, task);
    if (launchClaim.reserved) {
      await cliDeps.prepareRunWorldModel(launchClaim, task);
    }
  }
  if (opts.tmux && opts.pairedMode) {
    if (
      await cliDeps.runInTmux(normalizedArgv, undefined, {
        ...a2aLaunchField(a2aAs),
        opts,
        task,
      })
    ) {
      return true;
    }
    throw new Error(PAIRED_TMUX_HANDOFF_ERROR);
  }
  await cliDeps.runLoop(task, opts);
  return false;
};

export const runCli = async (argv: string[]): Promise<void> => {
  if (await runPreMaintenanceCommand(argv)) {
    return;
  }

  let shouldCloseAgents = true;
  let launchClaim: PairedLaunchClaim | undefined;
  let launchHandedOff = false;
  try {
    const invocationCwd = process.cwd();
    const a2aFlag = extractA2AAsFlag(argv);
    const normalizedArgv =
      a2aFlag.argv.length === 0 ? DEFAULT_TMUX_ARGV : a2aFlag.argv;
    // Launching a task does not grant fleet maintenance authority. Explicit
    // maintenance opt-in retains the existing guarded cleanup implementations.
    if (process.env.LOOP_STARTUP_MAINTENANCE === "1") {
      cliDeps.gcStaleClaudeBridgeRegistrations();
      cliDeps.gcStaleBridgeProcesses();
      cliDeps.gcAbandonedRunProcesses();
      await cliDeps.reconcileGovernessBeatWorkflows();
    }
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
    const prepared = await prepareCliLaunch(
      normalizedArgv,
      invocationCwd,
      a2aFlag.supervisorId
    );
    launchClaim = prepared.launchClaim;
    if (prepared.outerTmuxHandedOff) {
      shouldCloseAgents = false;
      return;
    }
    launchHandedOff = await executePreparedLaunch(normalizedArgv, prepared);
    shouldCloseAgents = !launchHandedOff;
  } finally {
    if (launchClaim && !launchHandedOff) {
      cliDeps.cancelPairedLaunch(launchClaim);
    }
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
