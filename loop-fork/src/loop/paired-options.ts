import { defaultPeerAgent } from "./agents";
import {
  buildCodexBridgeConfigArgs,
  claudeChannelServerName,
  ensureAgentBridgeConfig,
  injectProjectBridgeConfig,
  resolveClaudeChannelServerName,
} from "./bridge-config";
import { DEFAULT_CAVEMAN_MODE, DEFAULT_HELPER_CAVEMAN_MODE } from "./caveman";
import { ensureLoopCodexHome } from "./codex-home";
import {
  createRunManifest,
  ensureRunStorage,
  isActiveRunState,
  type RunManifest,
  type RunStorage,
  readRunManifest,
  resolveExistingRunId,
  resolveRepoId,
  resolveRunId,
  resolveRunStorage,
  resolveStorageRoot,
  touchRunManifest,
  writeRunManifest,
} from "./run-state";
import type { Options, PairedSessionIds } from "./types";

export interface PreparedRunState {
  allowRawSessionFallback: boolean;
  manifest?: RunManifest;
  storage: RunStorage;
}

export interface PreparedPairedRun {
  manifest: RunManifest;
  storage: RunStorage;
}

interface RequestedRunState {
  allowRawSessionFallback: boolean;
  runId?: string;
}

export const canResumePairedManifest = (manifest?: RunManifest): boolean => {
  return manifest ? isActiveRunState(manifest.state) : false;
};

const resolveClaudeBridgeServer = (
  storage: RunStorage,
  manifest?: RunManifest
): string =>
  resolveClaudeChannelServerName(
    storage.runId,
    storage.repoId,
    manifest?.claudeChannelServer
  );

const resolveRequestedRunState = (
  opts: Options,
  cwd: string
): RequestedRunState => {
  if (opts.resumeRunId) {
    const runId = resolveExistingRunId(opts.resumeRunId, cwd);
    if (!runId) {
      throw new Error(`[loop] paired run "${opts.resumeRunId}" does not exist`);
    }
    return { allowRawSessionFallback: false, runId };
  }

  if (!opts.sessionId?.trim()) {
    return { allowRawSessionFallback: false };
  }

  const runId = resolveExistingRunId(opts.sessionId, cwd);
  if (runId) {
    return { allowRawSessionFallback: false, runId };
  }
  return { allowRawSessionFallback: true };
};

const pairedSessionIds = (
  opts: Options,
  manifest: RunManifest | undefined,
  allowRawSessionFallback: boolean
): PairedSessionIds | undefined => {
  const stored = canResumePairedManifest(manifest) ? manifest : undefined;
  const sessionId = opts.sessionId?.trim();
  let fallback: PairedSessionIds | undefined;
  if (allowRawSessionFallback && sessionId) {
    fallback = { [opts.agent]: sessionId } as PairedSessionIds;
  }
  const claude = stored?.claudeSessionId || fallback?.claude || undefined;
  const codex = stored?.codexThreadId || fallback?.codex || undefined;
  const copilot = fallback?.copilot || undefined;
  const cursor = fallback?.cursor || undefined;
  const gemini = fallback?.gemini || undefined;
  if (!(claude || codex || copilot || cursor || gemini)) {
    return undefined;
  }
  return { claude, codex, copilot, cursor, gemini };
};

export const resolvePreparedRunState = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true
): PreparedRunState => {
  const requested = resolveRequestedRunState(opts, cwd);
  const repoId = resolveRepoId(cwd);
  const storageRoot = resolveStorageRoot();
  const runId =
    requested.runId ?? resolveRunId(storageRoot, repoId, process.env);
  process.env.LOOP_RUN_ID = runId;
  const storage = resolveRunStorage(runId, cwd);
  ensureRunStorage(storage);
  const existingManifest = readRunManifest(storage.manifestPath);
  if (existingManifest) {
    return {
      allowRawSessionFallback: requested.allowRawSessionFallback,
      manifest: existingManifest,
      storage,
    };
  }

  if (!createManifest) {
    return {
      allowRawSessionFallback: requested.allowRawSessionFallback,
      storage,
    };
  }

  const manifest = createRunManifest({
    cavemanMode: opts.cavemanMode ?? DEFAULT_CAVEMAN_MODE,
    claudeChannelServer: claudeChannelServerName(storage.runId, storage.repoId),
    claudeSessionId: "",
    codexThreadId: "",
    cwd,
    mode: "paired",
    helperCavemanMode: opts.helperCavemanMode ?? DEFAULT_HELPER_CAVEMAN_MODE,
    pid: process.pid,
    repoId: storage.repoId,
    runId: storage.runId,
    state: "submitted",
  });
  writeRunManifest(storage.manifestPath, manifest);
  return {
    allowRawSessionFallback: requested.allowRawSessionFallback,
    manifest,
    storage,
  };
};

export const applyPairedOptions = (
  opts: Options,
  storage: RunStorage,
  manifest: RunManifest | undefined,
  allowRawSessionFallback = false,
  cwd = process.cwd()
): void => {
  opts.cavemanMode ??= DEFAULT_CAVEMAN_MODE;
  opts.cavemanModeSource ??= "default";
  opts.helperCavemanMode ??= DEFAULT_HELPER_CAVEMAN_MODE;
  opts.helperCavemanModeSource ??= "default";
  opts.pairWith ??= defaultPeerAgent(opts.agent);
  const resumedSessionIds = pairedSessionIds(
    opts,
    manifest,
    allowRawSessionFallback
  );
  const pairedAgents = [opts.agent, opts.pairWith];
  const resumesLegacyMainSession =
    !manifest?.cavemanMode &&
    pairedAgents.some((agent) => Boolean(resumedSessionIds?.[agent]));
  if (resumesLegacyMainSession) {
    if (opts.cavemanModeSource === "cli" && opts.cavemanMode !== "off") {
      throw new Error(
        "Cannot apply a non-off --caveman mode to a legacy resumed agent session; start a new loop so the agent receives the selected guidance"
      );
    }
    opts.cavemanMode = "off";
    opts.cavemanModeSource = "manifest";
  }
  if (manifest?.cavemanMode && opts.cavemanModeSource !== "cli") {
    opts.cavemanMode = manifest.cavemanMode;
    opts.cavemanModeSource = "manifest";
  }
  if (manifest?.helperCavemanMode && opts.helperCavemanModeSource !== "cli") {
    opts.helperCavemanMode = manifest.helperCavemanMode;
    opts.helperCavemanModeSource = "manifest";
  }
  // Hook-triggered utility jobs resolve their runtime from process.env. Keep
  // the effective (possibly resumed) modes aligned with tmux-launched panes.
  process.env.LOOP_CAVEMAN_MODE = opts.cavemanMode;
  process.env.LOOP_HELPER_CAVEMAN_MODE = opts.helperCavemanMode;
  opts.claudeMcpConfigPath = ensureAgentBridgeConfig(
    storage.runDir,
    "claude",
    resolveClaudeBridgeServer(storage, manifest)
  );
  opts.claudePersistentSession = true;
  opts.copilotMcpConfigPath = ensureAgentBridgeConfig(
    storage.runDir,
    "copilot"
  );
  opts.cursorMcpConfigPath = ensureAgentBridgeConfig(storage.runDir, "cursor");
  opts.codexMcpConfigArgs = buildCodexBridgeConfigArgs(storage.runDir, "codex");
  opts.codexHome = ensureLoopCodexHome(storage.runDir, cwd);
  opts.geminiMcpConfigPath = ensureAgentBridgeConfig(storage.runDir, "gemini");
  // Inject bridge MCP into project-level config only for agents in this pair
  const projectDir = cwd;
  const pair = [opts.agent, opts.pairWith].filter(Boolean);
  if (pair.includes("copilot")) {
    injectProjectBridgeConfig(projectDir, storage.runDir, "copilot");
  }
  if (pair.includes("cursor")) {
    injectProjectBridgeConfig(projectDir, storage.runDir, "cursor");
  }
  if (pair.includes("gemini")) {
    injectProjectBridgeConfig(projectDir, storage.runDir, "gemini");
  }
  opts.pairedMode = true;
  opts.pairedSessionIds = resumedSessionIds;
};

export const preparePairedOptions = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true
): void => {
  const { allowRawSessionFallback, manifest, storage } =
    resolvePreparedRunState(opts, cwd, createManifest);
  applyPairedOptions(opts, storage, manifest, allowRawSessionFallback, cwd);
};

export const preparePairedRun = (
  opts: Options,
  cwd = process.cwd()
): PreparedPairedRun => {
  const {
    allowRawSessionFallback,
    manifest: existing,
    storage,
  } = resolvePreparedRunState(opts, cwd);
  applyPairedOptions(opts, storage, existing, allowRawSessionFallback, cwd);

  const resumable = canResumePairedManifest(existing) ? existing : undefined;
  const selectedAgents = new Set([opts.agent, opts.pairWith]);
  const manifest = existing
    ? touchRunManifest(
        {
          ...existing,
          cavemanMode: opts.cavemanMode,
          claudeChannelServer: resolveClaudeBridgeServer(storage, existing),
          // A stored binding outside the selected pair cannot receive this
          // run's prompt contract. Drop it instead of later treating that
          // legacy session as if it had received the persisted mode.
          claudeSessionId: selectedAgents.has("claude")
            ? resumable?.claudeSessionId || opts.pairedSessionIds?.claude || ""
            : "",
          codexThreadId: selectedAgents.has("codex")
            ? resumable?.codexThreadId || opts.pairedSessionIds?.codex || ""
            : "",
          cwd,
          mode: "paired",
          helperCavemanMode: opts.helperCavemanMode,
          pid: process.pid,
          state: resumable?.state ?? "submitted",
          // Non-tmux resumes should not preserve a dead tmux routing hint.
          tmuxSession: opts.tmux ? existing.tmuxSession : undefined,
        },
        new Date().toISOString()
      )
    : createRunManifest({
        cavemanMode: opts.cavemanMode,
        claudeChannelServer: claudeChannelServerName(
          storage.runId,
          storage.repoId
        ),
        claudeSessionId: opts.pairedSessionIds?.claude ?? "",
        codexThreadId: opts.pairedSessionIds?.codex ?? "",
        cwd,
        mode: "paired",
        helperCavemanMode: opts.helperCavemanMode,
        pid: process.pid,
        repoId: storage.repoId,
        runId: storage.runId,
        state: "submitted",
      });
  writeRunManifest(storage.manifestPath, manifest);
  return { manifest, storage };
};
