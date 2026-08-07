import { spawnSync } from "bun";
import {
  defaultPeerAgent,
  isAgent,
  isRetiredAgent,
  retiredAgentMigrationMessage,
} from "./agents";
import {
  buildCodexBridgeConfigArgs,
  claudeChannelServerName,
  ensureAgentBridgeConfig,
  resolveClaudeChannelServerName,
} from "./bridge-config";
import { DEFAULT_CAVEMAN_MODE, DEFAULT_HELPER_CAVEMAN_MODE } from "./caveman";
import { ensureLoopCodexHome } from "./codex-home";
import {
  ensureOssConfig,
  OSS_COMMAND,
  type OssSessionLookup,
  ossSessionTitle,
  resolveOssSessionId,
} from "./oss-adapter";
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
import { type TmuxLiveness, tmuxSessionLiveness } from "./tmux-control";
import type { Agent, Options, PairedSessionIds } from "./types";

export interface PreparedRunState {
  allowRawSessionFallback: boolean;
  manifest?: RunManifest;
  storage: RunStorage;
}

export interface PreparedPairedRun {
  manifest: RunManifest;
  storage: RunStorage;
}

type TmuxSessionProbe = (session: string) => boolean | TmuxLiveness;

const isTmuxSessionLive: TmuxSessionProbe = (session) =>
  tmuxSessionLiveness(session, spawnSync);

const defaultOssSessionLookup: OssSessionLookup = (argv, env) => {
  const result = spawnSync([OSS_COMMAND, ...argv], { env, stderr: "ignore" });
  return result.success ? result.stdout.toString() : undefined;
};

const persistedTmuxIsLive = (
  enabled: boolean,
  session: string | undefined,
  sessionProbe: TmuxSessionProbe
): boolean => {
  if (!(enabled && session)) {
    return false;
  }
  const probed = sessionProbe(session);
  let liveness: TmuxLiveness;
  if (probed === true) {
    liveness = "live";
  } else if (probed === false) {
    liveness = "dead";
  } else {
    liveness = probed;
  }
  if (liveness === "unknown") {
    throw new Error(
      `tmux session "${session}" liveness is unknown; refusing to clear or duplicate it`
    );
  }
  return liveness === "live";
};

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

const restorePersistedTmuxPair = (
  opts: Options,
  manifest: RunManifest | undefined,
  livePersistedTmux: boolean
): void => {
  const left = manifest?.tmuxPaneLeftAgent;
  const right = manifest?.tmuxPaneRightAgent;
  if (!(livePersistedTmux && left && right && left !== right)) {
    return;
  }
  // A run persisted against a retired seat stays inspectable and reapable, but
  // relaunching it must fail here — before any pane or process is created.
  for (const stored of [left, right, manifest.primaryAgent]) {
    if (isRetiredAgent(stored)) {
      throw new Error(retiredAgentMigrationMessage(stored));
    }
  }
  if (!(isAgent(left) && isAgent(right))) {
    return;
  }
  const storedPair: Agent[] = [left, right];
  const stored = manifest.primaryAgent;
  const primary =
    isAgent(stored) && storedPair.includes(stored) ? stored : left;
  opts.agent = primary;
  opts.pairWith = primary === left ? right : left;
};

const resolveRequestedRunState = (
  opts: Options,
  cwd: string
): RequestedRunState => {
  if (opts.reservedRunId) {
    const runId = resolveExistingRunId(opts.reservedRunId, cwd);
    if (!runId) {
      throw new Error(
        `[loop] reserved paired run "${opts.reservedRunId}" does not exist`
      );
    }
    return {
      allowRawSessionFallback: Boolean(opts.sessionId && !opts.resumeRunId),
      runId,
    };
  }
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
  const oss = stored?.ossSessionId || fallback?.oss || undefined;
  if (!(claude || codex || oss)) {
    return undefined;
  }
  return { claude, codex, oss };
};

const applyLiveTmuxModeContract = (
  opts: Options,
  manifest: RunManifest | undefined,
  livePersistedTmux: boolean
): void => {
  if (!livePersistedTmux) {
    return;
  }
  const effortRoles = [
    {
      label: "driver",
      manifestValue: manifest?.driverEffort,
      optionKey: "driverEffort",
      sourceKey: "driverEffortSource",
    },
    {
      label: "reviewer",
      manifestValue: manifest?.reviewerEffort,
      optionKey: "reviewerEffort",
      sourceKey: "reviewerEffortSource",
    },
  ] as const;
  for (const role of effortRoles) {
    const requested = opts[role.optionKey];
    const source = opts[role.sourceKey];
    const explicitCli = source === "cli-global" || source === "cli-role";
    if (role.manifestValue) {
      if (explicitCli && requested !== role.manifestValue) {
        throw new Error(
          `Cannot change --effort-${role.label} from ${role.manifestValue} to ${requested} while reusing live tmux agents; start a new loop so the actual provider invocation receives the selected effort`
        );
      }
      opts[role.optionKey] = role.manifestValue;
      opts[role.sourceKey] = "manifest";
    } else if (explicitCli) {
      throw new Error(
        `Cannot apply --effort-${role.label} to legacy live tmux agents without persisted effort evidence; start a new loop`
      );
    }
  }
  if (
    manifest?.cavemanMode &&
    opts.cavemanModeSource === "cli" &&
    opts.cavemanMode !== manifest.cavemanMode
  ) {
    throw new Error(
      `Cannot change --caveman from ${manifest.cavemanMode} to ${opts.cavemanMode} while reusing live tmux agents; start a new loop so both agents receive the selected guidance`
    );
  }
  if (
    manifest?.helperCavemanMode &&
    opts.helperCavemanModeSource === "cli" &&
    opts.helperCavemanMode !== manifest.helperCavemanMode
  ) {
    throw new Error(
      `Cannot change --helper-caveman from ${manifest.helperCavemanMode} to ${opts.helperCavemanMode} while reusing a live Governess; start a new loop so helpers receive the selected guidance`
    );
  }
  if (manifest?.helperCavemanMode) {
    return;
  }
  if (
    opts.helperCavemanModeSource === "cli" &&
    opts.helperCavemanMode !== "off"
  ) {
    throw new Error(
      "Cannot apply a non-off --helper-caveman mode to a legacy live Governess; start a new loop so helpers receive the selected guidance"
    );
  }
  opts.helperCavemanMode = "off";
  opts.helperCavemanModeSource = "manifest";
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
  if (
    opts.launchAttemptId &&
    existingManifest?.launchAttemptId !== opts.launchAttemptId
  ) {
    throw new Error(
      `[loop] launch attempt ${opts.launchAttemptId} no longer owns run ${storage.runId}`
    );
  }
  if (
    opts.launchClaimId &&
    existingManifest?.launchClaimId !== opts.launchClaimId
  ) {
    throw new Error(
      `[loop] launch claim ${opts.launchClaimId} no longer owns run ${storage.runId}`
    );
  }
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
    ossSessionId: "",
    cwd,
    driverEffort: opts.driverEffort,
    mode: "paired",
    helperCavemanMode: opts.helperCavemanMode ?? DEFAULT_HELPER_CAVEMAN_MODE,
    pid: process.pid,
    repoId: storage.repoId,
    reviewerEffort: opts.reviewerEffort,
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
  cwd = process.cwd(),
  livePersistedTmux = false,
  ossLookup: OssSessionLookup = defaultOssSessionLookup
): void => {
  opts.cavemanMode ??= DEFAULT_CAVEMAN_MODE;
  opts.cavemanModeSource ??= "default";
  opts.helperCavemanMode ??= DEFAULT_HELPER_CAVEMAN_MODE;
  opts.helperCavemanModeSource ??= "default";
  // Reusing an existing tmux session reuses its panes. Keep routing and the
  // prompt contract bound to those actual agents instead of a new CLI default.
  restorePersistedTmuxPair(opts, manifest, livePersistedTmux);
  opts.pairWith ??= defaultPeerAgent(opts.agent);
  applyLiveTmuxModeContract(opts, manifest, livePersistedTmux);
  const resumedSessionIds = pairedSessionIds(
    opts,
    manifest,
    allowRawSessionFallback
  );
  const pairedAgents = [opts.agent, opts.pairWith];
  const resumesLegacyMainSession =
    !manifest?.cavemanMode &&
    opts.tmux &&
    (livePersistedTmux ||
      pairedAgents.some((agent) => Boolean(resumedSessionIds?.[agent])));
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
  opts.codexMcpConfigArgs = buildCodexBridgeConfigArgs(storage.runDir, "codex");
  opts.codexHome = ensureLoopCodexHome(storage.runDir, cwd, {
    ...process.env,
    // Only the tmux topology starts Governess and installs provider hooks.
    // Legacy foreground paired runs stay explicitly outside this policy rather
    // than advertising utility-first while leaving native spawning ungated.
    LOOP_NATIVE_SUBAGENT_MODE:
      opts.governess && opts.tmux
        ? process.env.LOOP_NATIVE_SUBAGENT_MODE
        : "off",
  });
  // Run-scoped OpenCode configuration: exactly this run's bridge plus an
  // explicit permission policy, so the seat never inherits the operator's
  // global OpenCode MCP servers.
  opts.ossConfigDir = ensureOssConfig(storage.runDir);
  opts.ossSessionTitle = ossSessionTitle(storage.runId);
  opts.pairedMode = true;
  opts.pairedSessionIds = resolveOssPairedSession(
    opts,
    resumedSessionIds,
    ossLookup
  );
};

// A tmux pane's OpenCode session is not visible to this process while it runs,
// so a resume recovers it by the title the launch gave it. Only ever called
// when the OSS seat is actually selected.
const resolveOssPairedSession = (
  opts: Options,
  resumed: PairedSessionIds | undefined,
  lookup: OssSessionLookup
): PairedSessionIds | undefined => {
  const selected = [opts.agent, opts.pairWith].includes("oss");
  if (!(selected && opts.ossSessionTitle) || resumed?.oss) {
    return resumed;
  }
  const oss = resolveOssSessionId(
    resumed?.oss,
    opts.ossSessionTitle,
    lookup,
    process.env,
    opts.ossConfigDir
  );
  if (!oss) {
    return resumed;
  }
  return { ...resumed, oss };
};

export const preparePairedOptions = (
  opts: Options,
  cwd = process.cwd(),
  createManifest = true,
  sessionProbe: TmuxSessionProbe = isTmuxSessionLive
): void => {
  const { allowRawSessionFallback, manifest, storage } =
    resolvePreparedRunState(opts, cwd, createManifest);
  const livePersistedTmux = persistedTmuxIsLive(
    opts.tmux === true,
    manifest?.tmuxSession,
    sessionProbe
  );
  applyPairedOptions(
    opts,
    storage,
    manifest,
    allowRawSessionFallback,
    cwd,
    livePersistedTmux
  );
};

const preparedEffortManifestFields = (
  opts: Options,
  existing: RunManifest,
  livePersistedTmux: boolean
): Pick<RunManifest, "driverEffort" | "reviewerEffort"> => ({
  ...(livePersistedTmux && !existing.driverEffort
    ? {}
    : { driverEffort: opts.driverEffort }),
  ...(livePersistedTmux && !existing.reviewerEffort
    ? {}
    : { reviewerEffort: opts.reviewerEffort }),
});

export const preparePairedRun = (
  opts: Options,
  cwd = process.cwd(),
  sessionProbe: TmuxSessionProbe = isTmuxSessionLive
): PreparedPairedRun => {
  const {
    allowRawSessionFallback,
    manifest: existing,
    storage,
  } = resolvePreparedRunState(opts, cwd);
  const livePersistedTmux = persistedTmuxIsLive(
    opts.tmux === true,
    existing?.tmuxSession,
    sessionProbe
  );
  applyPairedOptions(
    opts,
    storage,
    existing,
    allowRawSessionFallback,
    cwd,
    livePersistedTmux
  );

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
          claudeSessionId:
            livePersistedTmux || selectedAgents.has("claude")
              ? resumable?.claudeSessionId ||
                opts.pairedSessionIds?.claude ||
                ""
              : "",
          codexThreadId:
            livePersistedTmux || selectedAgents.has("codex")
              ? resumable?.codexThreadId || opts.pairedSessionIds?.codex || ""
              : "",
          ossSessionId:
            livePersistedTmux || selectedAgents.has("oss")
              ? resumable?.ossSessionId || opts.pairedSessionIds?.oss || ""
              : "",
          cwd,
          ...preparedEffortManifestFields(opts, existing, livePersistedTmux),
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
        ossSessionId: opts.pairedSessionIds?.oss ?? "",
        cwd,
        driverEffort: opts.driverEffort,
        mode: "paired",
        helperCavemanMode: opts.helperCavemanMode,
        pid: process.pid,
        repoId: storage.repoId,
        reviewerEffort: opts.reviewerEffort,
        runId: storage.runId,
        state: "submitted",
      });
  writeRunManifest(storage.manifestPath, manifest);
  return { manifest, storage };
};
