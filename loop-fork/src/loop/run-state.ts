import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
} from "node:path";
import { isAgent } from "./agents";
import { isEffortLevel } from "./effort";
import {
  type GitResult,
  runGit as runGitCommand,
  sanitizeBase,
  validateRunId,
} from "./git";
import { LEGACY_MANIFEST_KEYS } from "./legacy-governess-compat";
import type {
  Agent,
  CavemanMode,
  EffortLevel,
  LaunchWorkspaceBinding,
  PlanReviewMode,
  ReviewMode,
  ReviewStatus,
  RunLifecycleState,
  RunStatus,
} from "./types";

const RUNS_ROOT = join(".loop", "runs");
const MANIFEST_FILE = "manifest.json";
const TRANSCRIPT_FILE = "transcript.jsonl";
const LINE_SPLIT_RE = /\r?\n/;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const GIT_SHA_RE = /^[a-f0-9]{40,64}$/u;
const ACTIVE_RUN_STATES = new Set<RunLifecycleState>([
  "submitted",
  "working",
  "reviewing",
  "input-required",
]);

const isRunLifecycleState = (value: string): value is RunLifecycleState =>
  value === "submitted" ||
  value === "working" ||
  value === "reviewing" ||
  value === "input-required" ||
  value === "completed" ||
  value === "failed" ||
  value === "stopped";

const isReviewStatus = (value: string): value is ReviewStatus =>
  value === "pass" || value === "fail";

export interface RunStorage {
  manifestPath: string;
  repoId: string;
  runDir: string;
  runId: string;
  storageRoot: string;
  transcriptPath: string;
}

export interface RunLaunchCharter {
  bytes: number;
  path: string;
  sha256: string;
}

export interface RunWorldModelBinding {
  capsuleSha256: string;
  commitSha: string;
  contextPath: string;
  contextSha256: string;
  databasePath: string;
  entityCount: number;
  generatedAt: string;
  ontologyVersion: string;
  seeds: string[];
  statementCount: number;
}

export interface RunTmuxAdapterIdentity {
  processBirthId: string;
  serverPid: number;
  socketPath: string;
  version: 1;
}

export interface RunResolvedConfig {
  governess: boolean;
  pairedMode: boolean;
  proofConfigured: boolean;
  review?: ReviewMode;
  reviewPlan?: PlanReviewMode;
  tmux: boolean;
  version: 1;
  worktree: boolean;
}

export interface RunManifest {
  cavemanMode?: CavemanMode;
  claudeChannelServer?: string;
  claudeSessionId: string;
  codexAppServerPid?: number;
  codexRemoteUrl?: string;
  codexThreadId: string;
  createdAt: string;
  cwd: string;
  driverEffort?: EffortLevel;
  governess?: boolean;
  helperCavemanMode?: CavemanMode;
  launchAttemptId?: string;
  launchAttemptPid?: number;
  launchCharters?: Partial<Record<Agent, RunLaunchCharter>>;
  launchClaimId?: string;
  readonly manifestRevision?: string;
  mode: string;
  pid: number;
  primaryAgent?: Agent;
  repoId: string;
  resolvedConfig?: Readonly<RunResolvedConfig>;
  reviewerEffort?: EffortLevel;
  runId: string;
  sourceTaskSha256?: string;
  state: RunLifecycleState;
  status: RunStatus;
  tmuxAdapterIdentity?: Readonly<RunTmuxAdapterIdentity>;
  tmuxPaneAuPair?: string;
  tmuxPaneGoverness?: string;
  tmuxPaneLeft?: string;
  tmuxPaneLeftAgent?: Agent;
  tmuxPaneNanny?: string;
  tmuxPaneRecon?: string[];
  tmuxPaneRight?: string;
  tmuxPaneRightAgent?: Agent;
  tmuxPaneUtility?: string;
  tmuxSession?: string;
  updatedAt: string;
  workspaceBinding?: LaunchWorkspaceBinding;
  worldModel?: RunWorldModelBinding;
}

export interface RunMessageTranscriptEntry {
  at: string;
  from: string;
  kind?: "message";
  message: string;
  to?: string;
}

export interface RunStatusTranscriptEntry {
  at: string;
  detail?: string;
  kind: "status";
  state: RunLifecycleState;
}

export interface RunReviewTranscriptEntry {
  at: string;
  kind: "review";
  reason?: string;
  reviewer: Agent;
  status: ReviewStatus;
}

export interface RunResultTranscriptEntry {
  at: string;
  detail?: string;
  kind: "result";
  result:
    | "done-signal-detected"
    | "failed"
    | "max-iterations-reached"
    | "stopped";
}

export type RunTranscriptEntry =
  | RunMessageTranscriptEntry
  | RunResultTranscriptEntry
  | RunReviewTranscriptEntry
  | RunStatusTranscriptEntry;

const RUN_INDEX_RE = /^\d+$/;

export interface RunState {
  manifest?: RunManifest;
  storage: RunStorage;
  transcript: RunTranscriptEntry[];
}

interface RepoIdDeps {
  runGit: (args: string[]) => GitResult;
}

interface RunManifestInput {
  cavemanMode?: CavemanMode;
  claudeChannelServer?: string;
  claudeSessionId?: string;
  codexAppServerPid?: number;
  codexRemoteUrl?: string;
  codexThreadId?: string;
  createdAt?: string;
  cwd: string;
  driverEffort?: EffortLevel;
  governess?: boolean;
  helperCavemanMode?: CavemanMode;
  launchAttemptId?: string;
  launchAttemptPid?: number;
  launchClaimId?: string;
  mode: string;
  pid: number;
  primaryAgent?: Agent;
  repoId: string;
  resolvedConfig?: RunResolvedConfig;
  reviewerEffort?: EffortLevel;
  runId: string;
  sourceTaskSha256?: string;
  state?: RunLifecycleState;
  status?: string;
  tmuxAdapterIdentity?: RunTmuxAdapterIdentity;
  tmuxPaneAuPair?: string;
  tmuxPaneGoverness?: string;
  tmuxPaneLeft?: string;
  tmuxPaneLeftAgent?: Agent;
  tmuxPaneNanny?: string;
  tmuxPaneRecon?: string[];
  tmuxPaneRight?: string;
  tmuxPaneRightAgent?: Agent;
  tmuxPaneUtility?: string;
  tmuxSession?: string;
  updatedAt?: string;
  workspaceBinding?: LaunchWorkspaceBinding;
  worldModel?: RunWorldModelBinding;
}

const cavemanManifestFields = (
  input: Pick<RunManifestInput, "cavemanMode" | "helperCavemanMode">
): Pick<RunManifest, "cavemanMode" | "helperCavemanMode"> => ({
  ...(input.cavemanMode ? { cavemanMode: input.cavemanMode } : {}),
  ...(input.helperCavemanMode
    ? { helperCavemanMode: input.helperCavemanMode }
    : {}),
});

const effortManifestFields = (
  input: Pick<RunManifestInput, "driverEffort" | "reviewerEffort">
): Pick<RunManifest, "driverEffort" | "reviewerEffort"> => ({
  ...(input.driverEffort ? { driverEffort: input.driverEffort } : {}),
  ...(input.reviewerEffort ? { reviewerEffort: input.reviewerEffort } : {}),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(value, key);

const PROCESS_BIRTH_ID_RE = /^(?:darwin|linux):[1-9][0-9]*$/u;
const TMUX_ADAPTER_IDENTITY_KEYS = new Set([
  "processBirthId",
  "serverPid",
  "socketPath",
  "version",
]);
const RESOLVED_CONFIG_KEYS = new Set([
  "governess",
  "pairedMode",
  "proofConfigured",
  "review",
  "reviewPlan",
  "tmux",
  "version",
  "worktree",
]);

const isReviewMode = (value: unknown): value is ReviewMode =>
  value === "claudex" || (typeof value === "string" && isAgent(value));

const isPlanReviewMode = (value: unknown): value is PlanReviewMode =>
  value === "other" ||
  value === "none" ||
  (typeof value === "string" && isAgent(value));

const readTmuxAdapterIdentity = (
  value: unknown
): Readonly<RunTmuxAdapterIdentity> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    Object.keys(value).some((key) => !TMUX_ADAPTER_IDENTITY_KEYS.has(key)) ||
    value.version !== 1 ||
    typeof value.socketPath !== "string" ||
    !isAbsolute(value.socketPath) ||
    typeof value.serverPid !== "number" ||
    !Number.isInteger(value.serverPid) ||
    value.serverPid <= 0 ||
    typeof value.processBirthId !== "string" ||
    !PROCESS_BIRTH_ID_RE.test(value.processBirthId)
  ) {
    return undefined;
  }
  return Object.freeze({
    processBirthId: value.processBirthId,
    serverPid: value.serverPid,
    socketPath: value.socketPath,
    version: 1,
  });
};

const readResolvedConfig = (
  value: unknown
): Readonly<RunResolvedConfig> | undefined => {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !RESOLVED_CONFIG_KEYS.has(key)) ||
    value.version !== 1 ||
    typeof value.governess !== "boolean" ||
    typeof value.pairedMode !== "boolean" ||
    typeof value.proofConfigured !== "boolean" ||
    typeof value.tmux !== "boolean" ||
    typeof value.worktree !== "boolean" ||
    (hasOwn(value, "review") && !isReviewMode(value.review)) ||
    (hasOwn(value, "reviewPlan") && !isPlanReviewMode(value.reviewPlan))
  ) {
    return undefined;
  }
  return Object.freeze({
    governess: value.governess,
    pairedMode: value.pairedMode,
    proofConfigured: value.proofConfigured,
    ...(isReviewMode(value.review) ? { review: value.review } : {}),
    ...(isPlanReviewMode(value.reviewPlan)
      ? { reviewPlan: value.reviewPlan }
      : {}),
    tmux: value.tmux,
    version: 1,
    worktree: value.worktree,
  });
};

const tmuxAdapterManifestFields = (
  value: RunTmuxAdapterIdentity | undefined
): Pick<RunManifest, "tmuxAdapterIdentity"> => {
  if (!value) {
    return {};
  }
  const tmuxAdapterIdentity = readTmuxAdapterIdentity(value);
  if (!tmuxAdapterIdentity) {
    throw new Error("Invalid tmux adapter identity");
  }
  return { tmuxAdapterIdentity };
};

const resolvedConfigManifestFields = (
  value: RunResolvedConfig | undefined
): Pick<RunManifest, "resolvedConfig"> => {
  if (!value) {
    return {};
  }
  const resolvedConfig = readResolvedConfig(value);
  if (!resolvedConfig) {
    throw new Error("Invalid resolved run configuration");
  }
  return { resolvedConfig };
};

const readAdapterManifestFields = (
  parsed: Record<string, unknown>
): Pick<RunManifest, "resolvedConfig" | "tmuxAdapterIdentity"> => {
  const tmuxAdapterIdentity = readTmuxAdapterIdentity(
    parsed.tmuxAdapterIdentity
  );
  if (hasOwn(parsed, "tmuxAdapterIdentity") && !tmuxAdapterIdentity) {
    throw new Error("Invalid tmux adapter identity");
  }
  const resolvedConfig = readResolvedConfig(parsed.resolvedConfig);
  if (hasOwn(parsed, "resolvedConfig") && !resolvedConfig) {
    throw new Error("Invalid resolved run configuration");
  }
  return {
    ...(resolvedConfig ? { resolvedConfig } : {}),
    ...(tmuxAdapterIdentity ? { tmuxAdapterIdentity } : {}),
  };
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const firstString = (
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const value = asString(obj[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const firstEffortLevel = (
  obj: Record<string, unknown>,
  keys: string[]
): EffortLevel | undefined => {
  const value = firstString(obj, keys);
  return value && isEffortLevel(value) ? value : undefined;
};

const firstStringArray = (
  obj: Record<string, unknown>,
  keys: string[]
): string[] | undefined => {
  for (const key of keys) {
    const value = obj[key];
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      return [...value];
    }
  }
  return undefined;
};

const firstInteger = (
  obj: Record<string, unknown>,
  keys: string[]
): number | undefined => {
  for (const key of keys) {
    const value = obj[key];
    const integer = asInteger(value);
    if (integer !== undefined) {
      return integer;
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const firstAgent = (
  obj: Record<string, unknown>,
  keys: string[]
): Agent | undefined => {
  const value = firstString(obj, keys);
  return value && isAgent(value) ? value : undefined;
};

const firstCavemanMode = (
  obj: Record<string, unknown>,
  keys: string[]
): CavemanMode | undefined => {
  const value = firstString(obj, keys);
  return value === "off" ||
    value === "lite" ||
    value === "full" ||
    value === "ultra"
    ? value
    : undefined;
};

const readLaunchCharters = (
  value: unknown
): Partial<Record<Agent, RunLaunchCharter>> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const charters: Partial<Record<Agent, RunLaunchCharter>> = {};
  for (const [agent, candidate] of Object.entries(value)) {
    if (!(isAgent(agent) && isRecord(candidate))) {
      continue;
    }
    const path = asString(candidate.path);
    const sha256 = asString(candidate.sha256);
    const bytes = asInteger(candidate.bytes);
    if (
      path &&
      SHA256_RE.test(sha256 ?? "") &&
      bytes !== undefined &&
      bytes >= 0
    ) {
      charters[agent] = { bytes, path, sha256: sha256 as string };
    }
  }
  return Object.keys(charters).length > 0 ? charters : undefined;
};

const launchCharterManifestFields = (
  parsed: Record<string, unknown>
): Pick<RunManifest, "launchCharters"> => {
  const launchCharters = readLaunchCharters(
    parsed.launchCharters ?? parsed.launch_charters
  );
  return launchCharters ? { launchCharters } : {};
};

const readWorldModelBinding = (
  value: unknown
): RunWorldModelBinding | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const capsuleSha256 = firstString(value, ["capsuleSha256"]);
  const commitSha = firstString(value, ["commitSha"]);
  const contextPath = firstString(value, ["contextPath"]);
  const contextSha256 = firstString(value, ["contextSha256"]);
  const databasePath = firstString(value, ["databasePath"]);
  const entityCount = firstInteger(value, ["entityCount"]);
  const generatedAt = firstString(value, ["generatedAt"]);
  const ontologyVersion = firstString(value, ["ontologyVersion"]);
  const seeds = firstStringArray(value, ["seeds"]);
  const statementCount = firstInteger(value, ["statementCount"]);
  if (
    !(
      capsuleSha256 &&
      SHA256_RE.test(capsuleSha256) &&
      commitSha &&
      GIT_SHA_RE.test(commitSha) &&
      contextPath &&
      isAbsolute(contextPath) &&
      contextSha256 &&
      SHA256_RE.test(contextSha256) &&
      databasePath &&
      isAbsolute(databasePath) &&
      entityCount !== undefined &&
      entityCount > 0 &&
      generatedAt &&
      !Number.isNaN(new Date(generatedAt).valueOf()) &&
      ontologyVersion &&
      seeds &&
      statementCount !== undefined &&
      statementCount >= 0
    )
  ) {
    return undefined;
  }
  return {
    capsuleSha256,
    commitSha,
    contextPath,
    contextSha256,
    databasePath,
    entityCount,
    generatedAt: new Date(generatedAt).toISOString(),
    ontologyVersion,
    seeds,
    statementCount,
  };
};

const worldModelManifestFields = (
  value: RunWorldModelBinding | undefined
): Pick<RunManifest, "worldModel"> => {
  if (!value) {
    return {};
  }
  const worldModel = readWorldModelBinding(value);
  if (!worldModel) {
    throw new Error("Invalid run World Model binding");
  }
  return { worldModel };
};

const readWorldModelManifestFields = (
  parsed: Record<string, unknown>,
  manifestPath: string
): Pick<RunManifest, "worldModel"> => {
  const worldModel = readWorldModelBinding(
    parsed.worldModel ?? parsed.world_model
  );
  if (!worldModel) {
    return {};
  }
  const worldModelDir = resolvePath(dirname(manifestPath), "world-model");
  const pathsAreRunScoped = [
    worldModel.contextPath,
    worldModel.databasePath,
  ].every((path) => {
    const scoped = relative(worldModelDir, resolvePath(path));
    return Boolean(scoped && !scoped.startsWith("..") && !isAbsolute(scoped));
  });
  return pathsAreRunScoped ? { worldModel } : {};
};

const readWorkspaceBinding = (
  value: unknown
): LaunchWorkspaceBinding | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const root = firstString(value, ["root"]);
  const repoId = firstString(value, ["repoId", "repo_id"]);
  if (!(root && repoId)) {
    return undefined;
  }
  const branchRef = firstString(value, ["branchRef", "branch_ref"]);
  return {
    ...(branchRef ? { branchRef } : {}),
    repoId,
    root,
  };
};

const validateSourceTaskSha256 = (value: string): string => {
  if (!SHA256_RE.test(value)) {
    throw new Error("Invalid source task SHA-256");
  }
  return value;
};

const launchReservationManifestFields = (
  input: Pick<
    RunManifestInput,
    | "launchAttemptId"
    | "launchAttemptPid"
    | "launchClaimId"
    | "sourceTaskSha256"
    | "workspaceBinding"
  >
): Pick<
  RunManifest,
  | "launchAttemptId"
  | "launchAttemptPid"
  | "launchClaimId"
  | "sourceTaskSha256"
  | "workspaceBinding"
> => ({
  ...(input.launchAttemptId ? { launchAttemptId: input.launchAttemptId } : {}),
  ...(input.launchAttemptPid
    ? { launchAttemptPid: input.launchAttemptPid }
    : {}),
  ...(input.launchClaimId ? { launchClaimId: input.launchClaimId } : {}),
  ...(input.sourceTaskSha256
    ? { sourceTaskSha256: validateSourceTaskSha256(input.sourceTaskSha256) }
    : {}),
  ...(input.workspaceBinding
    ? { workspaceBinding: { ...input.workspaceBinding } }
    : {}),
});

const readLaunchReservationManifestFields = (
  parsed: Record<string, unknown>
): Pick<
  RunManifest,
  | "launchAttemptId"
  | "launchAttemptPid"
  | "launchClaimId"
  | "sourceTaskSha256"
  | "workspaceBinding"
> => {
  const launchAttemptId = firstString(parsed, [
    "launchAttemptId",
    "launch_attempt_id",
  ]);
  const launchAttemptPid = firstInteger(parsed, [
    "launchAttemptPid",
    "launch_attempt_pid",
  ]);
  const launchClaimId = firstString(parsed, [
    "launchClaimId",
    "launch_claim_id",
  ]);
  const sourceTaskSha256Candidate = firstString(parsed, [
    "sourceTaskSha256",
    "source_task_sha256",
  ]);
  const sourceTaskSha256 =
    sourceTaskSha256Candidate && SHA256_RE.test(sourceTaskSha256Candidate)
      ? sourceTaskSha256Candidate
      : undefined;
  const workspaceBinding = readWorkspaceBinding(
    parsed.workspaceBinding ?? parsed.workspace_binding
  );
  return {
    ...(launchAttemptId ? { launchAttemptId } : {}),
    ...(launchAttemptPid && launchAttemptPid > 0 ? { launchAttemptPid } : {}),
    ...(launchClaimId ? { launchClaimId } : {}),
    ...(sourceTaskSha256 ? { sourceTaskSha256 } : {}),
    ...(workspaceBinding ? { workspaceBinding } : {}),
  };
};

const optionalRunId = (runId: string | undefined): string | undefined => {
  if (!runId) {
    return undefined;
  }
  try {
    return validateRunId(runId);
  } catch {
    return undefined;
  }
};

const trimToken = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const parseRunLifecycleState = (
  state: string | undefined,
  status?: string
): RunLifecycleState | undefined => {
  if (state && isRunLifecycleState(state)) {
    return state;
  }
  if (!status) {
    return undefined;
  }
  if (isRunLifecycleState(status)) {
    return status;
  }
  if (status === "active" || status === "running") {
    return "working";
  }
  if (status === "done") {
    return "completed";
  }
  return undefined;
};

export const runStatusFromState = (state: RunLifecycleState): RunStatus => {
  if (state === "completed") {
    return "done";
  }
  if (state === "failed") {
    return "failed";
  }
  if (state === "stopped") {
    return "stopped";
  }
  return "running";
};

export const isActiveRunState = (state: RunLifecycleState): boolean =>
  ACTIVE_RUN_STATES.has(state);

export const setRunManifestState = (
  manifest: RunManifest,
  state: RunLifecycleState,
  now = new Date().toISOString()
): RunManifest => ({
  ...manifest,
  state,
  status: runStatusFromState(state),
  updatedAt: now,
});

const gitText = (
  cwd: string,
  args: string[],
  deps?: Partial<RepoIdDeps>
): string | undefined => {
  const runGit =
    deps?.runGit ?? ((gitArgs: string[]) => runGitCommand(cwd, gitArgs));
  const result = runGit(args);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const text = result.stdout.trim();
  return text ? resolvePath(cwd, text) : undefined;
};

const hashSeed = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

const buildRepoId = (label: string, seed: string): string =>
  `${sanitizeBase(label)}-${hashSeed(seed)}`;

const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};

const readRunIndices = (path: string): number[] => {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readdirSync(path)
      .filter((name) => RUN_INDEX_RE.test(name))
      .map((name) => Number.parseInt(name, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
};

const readStoredRunIds = (path: string): string[] => {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readdirSync(path)
      .filter((name) => {
        try {
          validateRunId(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
};

export const resolveStorageRoot = (home = process.env.HOME ?? ""): string =>
  join(home || process.cwd(), RUNS_ROOT);

export const resolveRunId = (
  storageRoot: string,
  repoId: string,
  env: NodeJS.ProcessEnv = {}
): string => {
  const requested = asString(env.LOOP_RUN_ID);
  if (requested) {
    return validateRunId(requested);
  }

  const repoDir = join(storageRoot, repoId);
  const indices = readRunIndices(repoDir);
  const next = indices.at(-1) ?? 0;
  return String(next + 1);
};

export const resolveRepoId = (
  cwd = process.cwd(),
  deps?: Partial<RepoIdDeps>
): string => {
  const commonDir = gitText(
    cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    deps
  );
  if (commonDir) {
    return buildRepoId(basename(dirname(commonDir)), commonDir);
  }

  const topLevel = gitText(
    cwd,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    deps
  );
  if (topLevel) {
    return buildRepoId(basename(topLevel), topLevel);
  }

  return buildRepoId(basename(cwd) || "loop", cwd);
};

export const buildRunDir = (
  storageRoot: string,
  repoId: string,
  runId: string
): string => join(storageRoot, repoId, validateRunId(runId));

export const buildManifestPath = (runDir: string): string =>
  join(runDir, MANIFEST_FILE);

export const buildTranscriptPath = (runDir: string): string =>
  join(runDir, TRANSCRIPT_FILE);

export const resolveRunStorage = (
  runId: string,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): RunStorage => {
  const repoId = resolveRepoId(cwd, deps);
  const storageRoot = resolveStorageRoot(home);
  const runDir = buildRunDir(storageRoot, repoId, runId);
  return {
    manifestPath: buildManifestPath(runDir),
    repoId,
    runDir,
    runId: validateRunId(runId),
    storageRoot,
    transcriptPath: buildTranscriptPath(runDir),
  };
};

export const reserveRunStorage = (
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): RunStorage => {
  const repoId = resolveRepoId(cwd, deps);
  const storageRoot = resolveStorageRoot(home);
  const repoDir = join(storageRoot, repoId);
  mkdirSync(repoDir, { recursive: true });

  const indices = readRunIndices(repoDir);
  let nextIndex = (indices.at(-1) ?? 0) + 1;
  while (nextIndex <= Number.MAX_SAFE_INTEGER) {
    const runId = String(nextIndex);
    const runDir = buildRunDir(storageRoot, repoId, runId);
    try {
      mkdirSync(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        nextIndex += 1;
        continue;
      }
      throw error;
    }

    const storage: RunStorage = {
      manifestPath: buildManifestPath(runDir),
      repoId,
      runDir,
      runId,
      storageRoot,
      transcriptPath: buildTranscriptPath(runDir),
    };
    try {
      writeFileSync(storage.transcriptPath, "", {
        encoding: "utf8",
        flag: "wx",
      });
      return storage;
    } catch (error) {
      rmSync(runDir, { force: true, recursive: true });
      throw error;
    }
  }

  throw new Error(`Unable to reserve a run id for ${repoId}`);
};

export const resolveExistingRunId = (
  runId: string | undefined,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): string | undefined => {
  const selector = trimToken(runId);
  if (!selector) {
    return undefined;
  }

  const candidate = optionalRunId(selector);
  if (candidate) {
    const storage = resolveRunStorage(candidate, cwd, home, deps);
    if (readRunManifest(storage.manifestPath)) {
      return candidate;
    }
  }

  const repoId = resolveRepoId(cwd, deps);
  const repoDir = join(resolveStorageRoot(home), repoId);
  for (const storedRunId of readStoredRunIds(repoDir)) {
    const manifestPath = buildManifestPath(join(repoDir, storedRunId));
    const manifest = readRunManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    if (
      manifest.claudeSessionId === selector ||
      manifest.codexThreadId === selector
    ) {
      return manifest.runId;
    }
  }
  return undefined;
};

export const ensureRunStorage = (storage: RunStorage): void => {
  mkdirSync(storage.runDir, { recursive: true });
  if (!existsSync(storage.transcriptPath)) {
    writeFileSync(storage.transcriptPath, "", "utf8");
  }
};

export const updateRunManifest = (
  manifestPath: string,
  update: (manifest: RunManifest | undefined) => RunManifest | undefined
): RunManifest | undefined => {
  const next = update(readRunManifest(manifestPath));
  if (!next) {
    return undefined;
  }
  writeRunManifest(manifestPath, next);
  return readRunManifest(manifestPath) ?? next;
};

export const createRunManifest = (
  input: RunManifestInput,
  now = new Date().toISOString()
): RunManifest => {
  const state =
    input.state ??
    parseRunLifecycleState(undefined, input.status) ??
    "submitted";
  return {
    ...cavemanManifestFields(input),
    ...effortManifestFields(input),
    ...launchReservationManifestFields(input),
    ...resolvedConfigManifestFields(input.resolvedConfig),
    ...tmuxAdapterManifestFields(input.tmuxAdapterIdentity),
    ...worldModelManifestFields(input.worldModel),
    ...(input.claudeChannelServer
      ? { claudeChannelServer: input.claudeChannelServer }
      : {}),
    claudeSessionId: input.claudeSessionId ?? "",
    ...(input.codexAppServerPid
      ? { codexAppServerPid: input.codexAppServerPid }
      : {}),
    ...(input.codexRemoteUrl ? { codexRemoteUrl: input.codexRemoteUrl } : {}),
    codexThreadId: input.codexThreadId ?? "",
    createdAt: input.createdAt ?? now,
    cwd: input.cwd,
    mode: input.mode,
    pid: input.pid,
    ...(input.primaryAgent ? { primaryAgent: input.primaryAgent } : {}),
    repoId: input.repoId,
    runId: validateRunId(input.runId),
    state,
    status: runStatusFromState(state),
    ...(input.tmuxSession ? { tmuxSession: input.tmuxSession } : {}),
    ...(input.tmuxPaneLeftAgent
      ? { tmuxPaneLeftAgent: input.tmuxPaneLeftAgent }
      : {}),
    ...(input.tmuxPaneLeft ? { tmuxPaneLeft: input.tmuxPaneLeft } : {}),
    ...(input.tmuxPaneRightAgent
      ? { tmuxPaneRightAgent: input.tmuxPaneRightAgent }
      : {}),
    ...(input.tmuxPaneRight ? { tmuxPaneRight: input.tmuxPaneRight } : {}),
    ...(input.tmuxPaneGoverness
      ? { tmuxPaneGoverness: input.tmuxPaneGoverness }
      : {}),
    ...(input.tmuxPaneAuPair ? { tmuxPaneAuPair: input.tmuxPaneAuPair } : {}),
    ...(input.tmuxPaneNanny ? { tmuxPaneNanny: input.tmuxPaneNanny } : {}),
    ...(input.tmuxPaneRecon?.length
      ? { tmuxPaneRecon: [...input.tmuxPaneRecon] }
      : {}),
    ...(input.tmuxPaneUtility
      ? { tmuxPaneUtility: input.tmuxPaneUtility }
      : {}),
    ...(input.governess ? { governess: true } : {}),
    updatedAt: input.updatedAt ?? now,
  };
};

export const touchRunManifest = (
  manifest: RunManifest,
  now = new Date().toISOString()
): RunManifest => ({
  ...manifest,
  status: runStatusFromState(manifest.state),
  updatedAt: now,
});

export const writeRunManifest = (
  manifestPath: string,
  manifest: RunManifest
): void => {
  ensureParentDir(manifestPath);
  const { manifestRevision: _derivedRevision, ...persistedManifest } = manifest;
  const bytes = Buffer.from(
    `${JSON.stringify(persistedManifest, null, 2)}\n`,
    "utf8"
  );
  if (!parseRunManifestBytes(bytes, manifestPath)) {
    throw new Error("Invalid run manifest");
  }
  const tempPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(tempPath, bytes, { flag: "wx" });
    renameSync(tempPath, manifestPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
};

const readOptionalRunManifestFields = (
  parsed: Record<string, unknown>,
  manifestPath: string
): Partial<RunManifest> => {
  const claudeChannelServer = firstString(parsed, [
    "claudeChannelServer",
    "claude_channel_server",
  ]);
  const codexRemoteUrl = firstString(parsed, [
    "codexRemoteUrl",
    "codex_remote_url",
  ]);
  const parsedCodexAppServerPid = firstInteger(parsed, [
    "codexAppServerPid",
    "codex_app_server_pid",
  ]);
  const codexAppServerPid =
    parsedCodexAppServerPid && parsedCodexAppServerPid > 0
      ? parsedCodexAppServerPid
      : undefined;
  const primaryAgent = firstAgent(parsed, ["primaryAgent", "primary_agent"]);
  const driverEffort = firstEffortLevel(parsed, [
    "driverEffort",
    "driver_effort",
  ]);
  const reviewerEffort = firstEffortLevel(parsed, [
    "reviewerEffort",
    "reviewer_effort",
  ]);
  const cavemanMode = firstCavemanMode(parsed, ["cavemanMode", "caveman_mode"]);
  const helperCavemanMode = firstCavemanMode(parsed, [
    "helperCavemanMode",
    "helper_caveman_mode",
  ]);
  const tmuxSession = firstString(parsed, ["tmuxSession", "tmux_session"]);
  const tmuxPaneLeftAgent = firstAgent(parsed, [
    "tmuxPaneLeftAgent",
    "tmux_pane_left_agent",
  ]);
  const tmuxPaneLeft = firstString(parsed, ["tmuxPaneLeft", "tmux_pane_left"]);
  const tmuxPaneRightAgent = firstAgent(parsed, [
    "tmuxPaneRightAgent",
    "tmux_pane_right_agent",
  ]);
  const tmuxPaneRight = firstString(parsed, [
    "tmuxPaneRight",
    "tmux_pane_right",
  ]);
  const tmuxPaneGoverness = firstString(parsed, [
    "tmuxPaneGoverness",
    "tmux_pane_governess",
    LEGACY_MANIFEST_KEYS.pane,
    LEGACY_MANIFEST_KEYS.paneSnake,
  ]);
  const tmuxPaneUtility = firstString(parsed, [
    "tmuxPaneUtility",
    "tmux_pane_utility",
  ]);
  const tmuxPaneAuPair = firstString(parsed, [
    "tmuxPaneAuPair",
    "tmux_pane_au_pair",
  ]);
  const tmuxPaneNanny = firstString(parsed, [
    "tmuxPaneNanny",
    "tmux_pane_nanny",
  ]);
  const tmuxPaneRecon = firstStringArray(parsed, [
    "tmuxPaneRecon",
    "tmux_pane_recon",
  ]);
  const governess =
    parsed.governess === true || parsed[LEGACY_MANIFEST_KEYS.enabled] === true;
  return {
    ...readAdapterManifestFields(parsed),
    ...(cavemanMode ? { cavemanMode } : {}),
    ...effortManifestFields({ driverEffort, reviewerEffort }),
    ...(claudeChannelServer ? { claudeChannelServer } : {}),
    ...(codexAppServerPid ? { codexAppServerPid } : {}),
    ...(codexRemoteUrl ? { codexRemoteUrl } : {}),
    ...(governess ? { governess: true } : {}),
    ...(primaryAgent ? { primaryAgent } : {}),
    ...(helperCavemanMode ? { helperCavemanMode } : {}),
    ...launchCharterManifestFields(parsed),
    ...readLaunchReservationManifestFields(parsed),
    ...readWorldModelManifestFields(parsed, manifestPath),
    ...(tmuxPaneGoverness ? { tmuxPaneGoverness } : {}),
    ...(tmuxPaneAuPair ? { tmuxPaneAuPair } : {}),
    ...(tmuxPaneLeft ? { tmuxPaneLeft } : {}),
    ...(tmuxPaneLeftAgent ? { tmuxPaneLeftAgent } : {}),
    ...(tmuxPaneRight ? { tmuxPaneRight } : {}),
    ...(tmuxPaneRightAgent ? { tmuxPaneRightAgent } : {}),
    ...(tmuxPaneNanny ? { tmuxPaneNanny } : {}),
    ...(tmuxPaneRecon ? { tmuxPaneRecon } : {}),
    ...(tmuxPaneUtility ? { tmuxPaneUtility } : {}),
    ...(tmuxSession ? { tmuxSession } : {}),
  };
};

const parseRunManifestBytes = (
  bytes: Uint8Array,
  manifestPath: string
): RunManifest | undefined => {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }

    const runId = firstString(parsed, ["runId", "run_id"]);
    const repoId = firstString(parsed, ["repoId", "repo_id"]);
    const cwd = firstString(parsed, ["cwd"]);
    const mode = firstString(parsed, ["mode"]);
    const rawState = firstString(parsed, ["state"]);
    const status = firstString(parsed, ["status"]);
    const createdAt = firstString(parsed, ["createdAt", "created_at"]);
    const updatedAt = firstString(parsed, ["updatedAt", "updated_at"]);
    const pid = firstInteger(parsed, ["pid"]);
    const state = parseRunLifecycleState(rawState, status);
    if (!(runId && repoId)) {
      return undefined;
    }
    if (!cwd) {
      return undefined;
    }
    if (!mode) {
      return undefined;
    }
    if (!(status || state)) {
      return undefined;
    }
    if (!createdAt) {
      return undefined;
    }
    if (!updatedAt) {
      return undefined;
    }
    if (pid === undefined) {
      return undefined;
    }

    const manifest: RunManifest = {
      ...readOptionalRunManifestFields(parsed, manifestPath),
      claudeSessionId:
        firstString(parsed, ["claudeSessionId", "claude_session_id"]) ?? "",
      codexThreadId:
        firstString(parsed, ["codexThreadId", "codex_thread_id"]) ?? "",
      createdAt,
      cwd,
      mode,
      pid,
      repoId,
      runId,
      state: state ?? "working",
      status: state ? runStatusFromState(state) : "running",
      updatedAt,
    };
    Object.defineProperty(manifest, "manifestRevision", {
      configurable: false,
      enumerable: false,
      value: createHash("sha256").update(bytes).digest("hex"),
      writable: false,
    });
    return manifest;
  } catch {
    return undefined;
  }
};

export const readRunManifest = (
  manifestPath: string
): RunManifest | undefined => {
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    return parseRunManifestBytes(readFileSync(manifestPath), manifestPath);
  } catch {
    return undefined;
  }
};

export const loadRunState = (
  runId: string,
  cwd = process.cwd(),
  home = process.env.HOME ?? "",
  deps?: Partial<RepoIdDeps>
): RunState => {
  const storage = resolveRunStorage(runId, cwd, home, deps);
  return {
    manifest: readRunManifest(storage.manifestPath),
    storage,
    transcript: readRunTranscriptEntries(storage.transcriptPath),
  };
};

export const createRunTranscriptEntry = (
  from: string,
  message: string,
  to?: string,
  at = new Date().toISOString()
): RunMessageTranscriptEntry => ({
  at,
  from,
  message,
  to,
});

export const createRunStatusEntry = (
  state: RunLifecycleState,
  detail?: string,
  at = new Date().toISOString()
): RunStatusTranscriptEntry => ({
  at,
  ...(detail ? { detail } : {}),
  kind: "status",
  state,
});

export const createRunReviewEntry = (
  reviewer: Agent,
  status: ReviewStatus,
  reason?: string,
  at = new Date().toISOString()
): RunReviewTranscriptEntry => ({
  at,
  kind: "review",
  ...(reason ? { reason } : {}),
  reviewer,
  status,
});

export const createRunResultEntry = (
  result: RunResultTranscriptEntry["result"],
  detail?: string,
  at = new Date().toISOString()
): RunResultTranscriptEntry => ({
  at,
  ...(detail ? { detail } : {}),
  kind: "result",
  result,
});

const parseStatusTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunStatusTranscriptEntry | undefined => {
  const state = parseRunLifecycleState(asString(parsed.state));
  const detail = asString(parsed.detail);
  return state
    ? {
        at,
        ...(detail ? { detail } : {}),
        kind: "status",
        state,
      }
    : undefined;
};

const parseReviewTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunReviewTranscriptEntry | undefined => {
  const reviewer =
    typeof parsed.reviewer === "string" && isAgent(parsed.reviewer)
      ? parsed.reviewer
      : undefined;
  const reason = asString(parsed.reason);
  const status =
    typeof parsed.status === "string" && isReviewStatus(parsed.status)
      ? parsed.status
      : undefined;
  if (!(reviewer && status)) {
    return undefined;
  }
  return {
    at,
    kind: "review",
    ...(reason ? { reason } : {}),
    reviewer,
    status,
  };
};

const parseResultTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string
): RunResultTranscriptEntry | undefined => {
  const result = asString(parsed.result);
  const detail = asString(parsed.detail);
  if (
    !(
      result === "done-signal-detected" ||
      result === "failed" ||
      result === "max-iterations-reached" ||
      result === "stopped"
    )
  ) {
    return undefined;
  }
  return {
    at,
    ...(detail ? { detail } : {}),
    kind: "result",
    result,
  };
};

const parseMessageTranscriptEntry = (
  parsed: Record<string, unknown>,
  at: string,
  kind: string | undefined
): RunMessageTranscriptEntry | undefined => {
  const from = asString(parsed.from);
  const message = asString(parsed.message);
  if (!(from && message)) {
    return undefined;
  }
  return {
    at,
    from,
    kind: kind === "message" ? "message" : undefined,
    message,
    to: asString(parsed.to),
  };
};

const parseRunTranscriptEntry = (
  parsed: Record<string, unknown>
): RunTranscriptEntry | undefined => {
  const at = asString(parsed.at);
  if (!at) {
    return undefined;
  }

  const kind = asString(parsed.kind);
  if (kind === "status") {
    return parseStatusTranscriptEntry(parsed, at);
  }
  if (kind === "review") {
    return parseReviewTranscriptEntry(parsed, at);
  }
  if (kind === "result") {
    return parseResultTranscriptEntry(parsed, at);
  }
  return parseMessageTranscriptEntry(parsed, at, kind);
};

export const appendRunTranscriptEntry = (
  transcriptPath: string,
  entry: RunTranscriptEntry
): void => {
  ensureParentDir(transcriptPath);
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8");
};

export const readRunTranscriptEntries = (
  transcriptPath: string
): RunTranscriptEntry[] => {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const entries: RunTranscriptEntry[] = [];
  for (const line of readFileSync(transcriptPath, "utf8").split(
    LINE_SPLIT_RE
  )) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        continue;
      }
      const entry = parseRunTranscriptEntry(parsed);
      if (entry) {
        entries.push(entry);
      }
    } catch {
      // ignore malformed transcript lines
    }
  }
  return entries;
};
