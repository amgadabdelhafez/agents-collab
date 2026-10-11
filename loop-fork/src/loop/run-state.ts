import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
import { isAgent, isHistoricalAgent } from "./agents";
import { isEffortLevel } from "./effort";
import {
  type GitResult,
  runGit as runGitCommand,
  sanitizeBase,
  validateRunId,
} from "./git";
import { LEGACY_MANIFEST_KEYS } from "./legacy-governess-compat";
import { processGroupAlive } from "./process-group";
import { AGENT_GROUP_KIND, PANE_PROCESS_KIND } from "./run-pane-processes";
import { createManifestHandle, type ManifestHandle } from "./tmux-socket";
import type {
  Agent,
  CavemanMode,
  EffortLevel,
  HistoricalAgent,
  LaunchWorkspaceBinding,
  ReviewStatus,
  RunLifecycleState,
  RunStatus,
} from "./types";
import {
  readUtilityJobsAsEvidence,
  type UtilityJobsEvidence,
} from "./utility-store";

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

export interface RunManifest {
  /** The supervisor this run serves as an A2A V2 endpoint (`--a2a-as`). */
  a2aSupervisorId?: string;
  cavemanMode?: CavemanMode;
  claudeChannelServer?: string;
  // Version banner of the `claude` binary observed at launch, recorded for
  // forensics on kickoff-confirmation failures.
  claudeCliVersion?: string;
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
  mode: string;
  ossSessionId: string;
  pid: number;
  // Historical manifests may name a retired seat. Keep it readable for
  // diagnosis and reaping; launch and resume reject it separately.
  primaryAgent?: HistoricalAgent;
  repoId: string;
  reviewerEffort?: EffortLevel;
  runId: string;
  seatModels?: Partial<Record<Agent, string>>;
  seatModelsDriver?: Agent;
  sourceTaskSha256?: string;
  state: RunLifecycleState;
  status: RunStatus;
  tmuxPaneAuPair?: string;
  tmuxPaneGoverness?: string;
  tmuxPaneLeft?: string;
  tmuxPaneLeftAgent?: HistoricalAgent;
  tmuxPaneNanny?: string;
  tmuxPaneRecon?: string[];
  tmuxPaneRight?: string;
  tmuxPaneRightAgent?: HistoricalAgent;
  tmuxPaneUtility?: string;
  tmuxSession?: string;
  tmuxSocket?: string;
  updatedAt: string;
  workspaceBinding?: LaunchWorkspaceBinding;
  /**
   * Explicit marker that the run handed the workspace back. Retained only when
   * it is a syntactically and semantically valid UTC instant; a rolled-over
   * date such as `2026-02-30T18:30:00Z` is not a release.
   */
  workspaceReleasedAt?: string;
  /** Set by startup GC for a launch that never bound a tmux session. */
  workspaceReleaseKind?: "abandoned-never-bound";
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
  claudeCliVersion?: string;
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
  ossSessionId?: string;
  pid: number;
  primaryAgent?: HistoricalAgent;
  repoId: string;
  reviewerEffort?: EffortLevel;
  runId: string;
  // What each seat was launched with, so a finished run's evidence names the
  // models that produced it. The Governess records what it OBSERVES in the
  // seat-signals rows; this is the request, and the two can differ.
  seatModels?: Partial<Record<Agent, string>>;
  // The driver when seatModels was recorded. primaryAgent follows the current
  // driver across resumes, so it cannot say which role a saved model was for.
  seatModelsDriver?: Agent;
  sourceTaskSha256?: string;
  state?: RunLifecycleState;
  status?: string;
  tmuxPaneAuPair?: string;
  tmuxPaneGoverness?: string;
  tmuxPaneLeft?: string;
  tmuxPaneLeftAgent?: HistoricalAgent;
  tmuxPaneNanny?: string;
  tmuxPaneRecon?: string[];
  tmuxPaneRight?: string;
  tmuxPaneRightAgent?: HistoricalAgent;
  tmuxPaneUtility?: string;
  tmuxSession?: string;
  tmuxSocket?: string;
  updatedAt?: string;
  workspaceBinding?: LaunchWorkspaceBinding;
  workspaceReleaseKind?: "abandoned-never-bound";
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

/**
 * Reads the socket field. Unlike every other manifest field, a camel/snake
 * disagreement here is **not** resolved by preferring one key: a socket names
 * the server every consumer will address, so picking one of two disagreeing
 * values would silently target a server the manifest does not agree on.
 * A conflict is reported as explicit unknown targeting instead.
 */
const readSocketField = (
  obj: Record<string, unknown>
): { conflict: boolean; socket: string | undefined } => {
  const camel = asString(obj.tmuxSocket);
  const snake = asString(obj.tmux_socket);
  if (camel && snake && camel !== snake) {
    return { conflict: true, socket: undefined };
  }
  return { conflict: false, socket: camel ?? snake };
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

// Historical manifests may name a retired seat. Parsing keeps it so the run
// stays inspectable and reapable; launch and resume reject it separately.
const firstAgent = (
  obj: Record<string, unknown>,
  keys: string[]
): HistoricalAgent | undefined => {
  const value = firstString(obj, keys);
  return value && isHistoricalAgent(value) ? value : undefined;
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

/**
 * The manifest without its workspace handback. A handback belongs to a run
 * that ended; a run that is reserved or resumed again owns its workspace
 * again, so the marker (and its kind) must not survive into that life. Left
 * in place, it would make the teardown of the resumed run report an earlier
 * release as its own, and it is no longer true of the run.
 */
export const withoutWorkspaceHandback = (
  manifest: RunManifest
): RunManifest => {
  if (
    manifest.workspaceReleasedAt === undefined &&
    manifest.workspaceReleaseKind === undefined
  ) {
    return manifest;
  }
  const {
    workspaceReleasedAt: _releasedAt,
    workspaceReleaseKind: _releaseKind,
    ...rest
  } = manifest;
  return rest;
};

/** An active run never carries a handback (see `withoutWorkspaceHandback`). */
const handbackForState = (manifest: RunManifest): RunManifest =>
  isActiveRunState(manifest.state)
    ? withoutWorkspaceHandback(manifest)
    : manifest;

export const setRunManifestState = (
  manifest: RunManifest,
  state: RunLifecycleState,
  now = new Date().toISOString()
): RunManifest =>
  handbackForState({
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
      manifest.codexThreadId === selector ||
      manifest.ossSessionId === selector
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
  return next;
};

export type StoppedRunReconcileResult =
  | { runId: string; status: "changed"; workspaceReleasedAt: string }
  | { runId: string; status: "already-released"; workspaceReleasedAt: string }
  | { runId: string; status: "refused"; reason: string };

export interface StoppedRunReconcileDeps {
  /**
   * Judges each live recorded process another run may hold too (see
   * `RecordedProcessClassifier`). Absent, every live record counts.
   */
  classifyRecordedProcess?: RecordedProcessClassifier;
  /**
   * Whether a recorded process GROUP (a utility worker's, an agent pane's)
   * may still hold a run process: see `groupCanStillOwnRun`. Every production
   * caller supplies it; without it the pid rule or any live member counts.
   */
  groupCanStillOwnRun?: (pgid: number, reference: string) => boolean;
  now: () => string;
  pidCanStillOwnRun: (pid: number, stoppedAt: string) => boolean;
  runtimeAbsent: (manifestPath: string) => Promise<boolean>;
  terminalState?: "failed" | "stopped";
}

const INVALID_INSTANT = "invalid-instant";

/**
 * The latest of several instants, as the PID-reuse reference. A live PID is
 * provably unrelated only when it started strictly after a moment by which the
 * recorded process had certainly started; the LATER that moment, the fewer PIDs
 * qualify, so taking the maximum is the conservative choice. In particular a
 * hand-edited `workspaceReleasedAt` earlier than the run's last recorded
 * activity cannot license a live run process as "reused". Any unparsable
 * input yields an unparsable reference, which `pidCanStillOwnRun` reads as
 * ownership for every live PID.
 */
export const latestInstant = (...values: readonly string[]): string => {
  let latest: number | undefined;
  for (const value of values) {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      return INVALID_INSTANT;
    }
    latest = latest === undefined ? ms : Math.max(latest, ms);
  }
  return latest === undefined
    ? INVALID_INSTANT
    : new Date(latest).toISOString();
};

/** A run-owned PID recorded outside the manifest's own pid fields. */
export interface RecordedRunPid {
  /**
   * `pid` is a process GROUP id: the group may hold a run process while any
   * member exists, after its leader is gone (see `groupCanStillOwnRun`).
   */
  readonly group?: true;
  readonly pid: number;
  /** A moment by which the recorded process had certainly started. */
  readonly reference: string;
  readonly source: string;
}

/**
 * Release evidence for processes another run may hold too: built once per
 * evidence read, then asked for each live recorded process. `count: false`
 * means the live process does not keep this run's workspace owned (it is
 * shared with another live run and does not work in this workspace, or it is
 * a daemon that re-parented away and works outside it). `rule` names why.
 */
export type RecordedProcessClassifier = (
  manifestPath: string,
  manifest: RunManifest
) => (entry: RecordedRunPid) => {
  readonly count: boolean;
  readonly detail?: string;
  readonly otherRunId?: string;
  readonly rule: string;
};

export type AuxiliaryRunPids =
  | { readonly kind: "read"; readonly pids: readonly RecordedRunPid[] }
  | { readonly kind: "unreadable"; readonly reason: string };

const isPositiveSafePid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * `undefined` when the file is absent (a gone descendant group's record may be
 * pruned between the listing and the read); throws on any other read failure.
 * An agent pane record (`kind: "agent-pane"`) names the pane's process GROUP,
 * which can outlive the pane process; a descendant group record (`kind:
 * "agent-descendant-group"`) names the group of a tool subprocess the CLI
 * started outside the pane group (see `recordAgentDescendantGroups`).
 */
const readRecordedPidFile = (
  path: string,
  reference: string
): { group?: true; pid: number | undefined; reference: string } | undefined => {
  let raw: string;
  let mtime: Date;
  try {
    raw = readFileSync(path, "utf8");
    mtime = statSync(path).mtime;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let pid: unknown;
  let group = false;
  try {
    const record = JSON.parse(raw) as {
      kind?: unknown;
      pgid?: unknown;
      pid?: unknown;
    } | null;
    group =
      record?.kind === PANE_PROCESS_KIND || record?.kind === AGENT_GROUP_KIND;
    pid = group ? record?.pgid : record?.pid;
  } catch {
    pid = undefined;
  }
  return {
    ...(group ? { group: true as const } : {}),
    // A group id of 1 (or 0) is never a recordable group: it would address
    // every process (or the reader's own group), so it is unreadable.
    pid: isPositiveSafePid(pid) && !(group && pid <= 1) ? pid : undefined,
    // The file is written after its process exists, so its mtime is a moment
    // by which that process had started.
    reference: latestInstant(reference, mtime.toISOString()),
  };
};

/**
 * Every run-owned PID recorded beside the manifest: the Codex app-server, the
 * bridge worker (`bridge-worker.json`), each `run-processes/` entry, and the
 * worker of every claimed utility job (`utility/jobs.jsonl`). A
 * record that exists but names no valid PID is unreadable evidence, never
 * absence: the run may own a process we can no longer identify.
 */
export const readAuxiliaryRunPids = (
  manifestPath: string,
  manifest: RunManifest,
  reference: string,
  nowMs: number = Date.now()
): AuxiliaryRunPids => {
  const runDir = dirname(manifestPath);
  const pids: RecordedRunPid[] = [];
  if (manifest.codexAppServerPid !== undefined) {
    pids.push({
      pid: manifest.codexAppServerPid,
      reference,
      source: "codexAppServerPid",
    });
  }
  const files: { path: string; source: string }[] = [
    { path: join(runDir, "bridge-worker.json"), source: "bridge-worker.json" },
  ];
  const registry = join(runDir, "run-processes");
  try {
    for (const entry of readdirSync(registry).sort()) {
      files.push({
        path: join(registry, entry),
        source: `run-processes/${entry}`,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        kind: "unreadable",
        reason: `run-processes is unreadable: ${(error as Error).message}`,
      };
    }
  }
  for (const { path, source } of files) {
    let record: ReturnType<typeof readRecordedPidFile>;
    try {
      record = readRecordedPidFile(path, reference);
    } catch (error) {
      return {
        kind: "unreadable",
        reason: `${source} is unreadable: ${(error as Error).message}`,
      };
    }
    if (!record) {
      continue;
    }
    if (record.pid === undefined) {
      return { kind: "unreadable", reason: `${source} names no valid pid` };
    }
    pids.push({
      ...(record.group ? { group: true as const } : {}),
      pid: record.pid,
      reference: record.reference,
      source,
    });
  }
  const workers = readUtilityWorkerPids(runDir, nowMs);
  if (workers.kind === "unreadable") {
    return workers;
  }
  pids.push(...workers.pids);
  return { kind: "read", pids };
};

/**
 * How long a torn final append to `utility/jobs.jsonl` is treated as possibly
 * still in flight. An append is one write; a worker whose claim append was
 * torn throws at its very next store call, before any work. Past this grace
 * the torn line is a dead writer's remains, not a live worker's claim.
 */
export const UTILITY_TORN_TAIL_GRACE_MS = 60_000;

/**
 * The worker pid of every utility job the run ever claimed. A worker is
 * spawned detached with its cwd in the workspace and its pid is recorded
 * nowhere else, so it is release evidence like any other run process. Jobs
 * that already ended count too: a worker fenced or timed out may still be
 * exiting, and a dead or provably reused pid costs nothing.
 *
 * The PID-reuse reference is the claim instant ALONE. The worker writes its
 * own claim (`runUtilityWorker` calls `claimUtilityJob` with its own pid and
 * the time is taken in that process), so it had certainly started by then,
 * and a live process that started after the claim is provably not that
 * worker. Taking a later instant (such as the run's last update) would only
 * misread unrelated processes that recycled an old worker pid as the worker,
 * and a long run with many ended jobs would then rarely ever release.
 *
 * A journal that cannot be read is unreadable evidence, except for a torn
 * final append older than `UTILITY_TORN_TAIL_GRACE_MS`, which is dropped (see
 * `readUtilityJobsAsEvidence`). A fresh torn append may still be in flight.
 */
const readUtilityWorkerPids = (
  runDir: string,
  nowMs: number
): AuxiliaryRunPids => {
  let evidence: UtilityJobsEvidence;
  try {
    evidence = readUtilityJobsAsEvidence(runDir);
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `utility/jobs.jsonl is unreadable: ${(error as Error).message}`,
    };
  }
  const torn = evidence.tornTailModifiedAt;
  if (torn && !(nowMs - torn.getTime() >= UTILITY_TORN_TAIL_GRACE_MS)) {
    return {
      kind: "unreadable",
      reason: `utility/jobs.jsonl is unreadable: its final append (at ${torn.toISOString()}) is torn and may still be in flight`,
    };
  }
  const pids: RecordedRunPid[] = [];
  for (const job of evidence.jobs) {
    for (const event of job.events) {
      if (event.claim) {
        // The worker is spawned detached, so it leads its own process group
        // (pgid = its pid; both the installed ea968d82 line and this one spawn
        // it that way). Its bounded commands run in that group with their cwd
        // in the workspace and can outlive it, so the GROUP is the evidence.
        pids.push({
          group: true,
          pid: event.claim.workerPid,
          reference: latestInstant(event.at),
          source: `utility job ${job.jobId} worker`,
        });
      }
    }
  }
  return { kind: "read", pids };
};

/**
 * The first recorded auxiliary process that may still belong to the run, or a
 * reason the records cannot be read. `undefined` means every recorded process
 * is positively dead or provably a later, unrelated process.
 */
export const auxiliaryProcessOwnership = (
  manifestPath: string,
  manifest: RunManifest,
  reference: string,
  pidCanStillOwnRun: (pid: number, reference: string) => boolean,
  groupCanStillOwnRun: (
    pgid: number,
    reference: string
  ) => boolean = conservativeGroupOwnership(pidCanStillOwnRun),
  classifyRecordedProcess?: RecordedProcessClassifier
): string | undefined => {
  const auxiliary = readAuxiliaryRunPids(manifestPath, manifest, reference);
  if (auxiliary.kind === "unreadable") {
    return `recorded-process-evidence-unreadable: ${auxiliary.reason}`;
  }
  const classify = classifyRecordedProcess?.(manifestPath, manifest);
  const live = auxiliary.pids.find(
    (entry) =>
      (entry.group
        ? groupCanStillOwnRun(entry.pid, entry.reference)
        : pidCanStillOwnRun(entry.pid, entry.reference)) &&
      // A live process another run holds too, or a daemon that re-parented
      // away from the run outside its workspace, may not count.
      (classify?.(entry).count ?? true)
  );
  if (!live) {
    return undefined;
  }
  return live.group
    ? `recorded-process-may-be-live: ${live.source} pid ${live.pid} (or a member of its process group)`
    : `recorded-process-may-be-live: ${live.source} pid ${live.pid}`;
};

/**
 * The group rule for a caller that supplied only a pid rule: the leader by
 * that rule, or else any live member of the group. A leader the pid rule
 * proves reused may still be counted live here if it leads a group of its
 * own, which can only block a release, never grant one.
 */
const conservativeGroupOwnership =
  (pidCanStillOwnRun: (pid: number, reference: string) => boolean) =>
  (pgid: number, reference: string): boolean =>
    pidCanStillOwnRun(pgid, reference) || processGroupAlive(pgid);

const sameWorkspaceIdentity = (
  current: RunManifest,
  expected: RunManifest
): boolean =>
  current.runId === expected.runId &&
  current.repoId === expected.repoId &&
  current.cwd === expected.cwd &&
  JSON.stringify(current.workspaceBinding) ===
    JSON.stringify(expected.workspaceBinding) &&
  current.tmuxSession === expected.tmuxSession &&
  current.tmuxSocket === expected.tmuxSocket &&
  current.pid === expected.pid &&
  current.launchAttemptPid === expected.launchAttemptPid &&
  current.state === expected.state &&
  current.status === expected.status &&
  current.updatedAt === expected.updatedAt;

/**
 * Why a recorded process of the run (its pid, its launch attempt, or any
 * auxiliary process or group) may still be live, or `undefined` when none is.
 */
const recordedProcessRefusal = (
  manifestPath: string,
  manifest: RunManifest,
  evidence: RunOwnershipEvidence,
  reference: string,
  deps: StoppedRunReconcileDeps
): string | undefined => {
  if (
    evidence.pid.kind !== "valid" ||
    deps.pidCanStillOwnRun(evidence.pid.value, reference)
  ) {
    return "run-process-may-be-live";
  }
  const attempt = evidence.launchAttemptPid;
  if (
    attempt.kind === "invalid" ||
    attempt.kind === "conflicting" ||
    (attempt.kind === "valid" &&
      deps.pidCanStillOwnRun(attempt.value, reference))
  ) {
    return "launch-process-may-be-live";
  }
  return auxiliaryProcessOwnership(
    manifestPath,
    manifest,
    reference,
    deps.pidCanStillOwnRun,
    deps.groupCanStillOwnRun,
    deps.classifyRecordedProcess
  );
};

/**
 * Adds release proof to one legacy stopped manifest only after every ownership
 * fact is positive. Runtime checks are injected so this producer never signals
 * a process or addresses tmux on its own.
 */
export const reconcileLegacyStoppedRun = async (
  manifestPath: string,
  expectedRunId: string,
  deps: StoppedRunReconcileDeps
): Promise<StoppedRunReconcileResult> => {
  const terminalState = deps.terminalState ?? "stopped";
  const read = readReservationManifest(manifestPath);
  if (!read) {
    return {
      reason: "manifest-not-found",
      runId: expectedRunId,
      status: "refused",
    };
  }
  if (read.kind === "refuse") {
    return {
      reason: `invalid-ownership-evidence: ${read.reasons.join("; ")}`,
      runId: expectedRunId,
      status: "refused",
    };
  }
  const { evidence, manifest } = read;
  if (manifest.runId !== expectedRunId) {
    return {
      reason: "run-identity-mismatch",
      runId: expectedRunId,
      status: "refused",
    };
  }
  // The state first: a recorded handback speaks only for a run that is still
  // in the terminal state it was released in. A run that was resumed since is
  // a new life of the run, and an earlier marker is no release of it.
  if (
    evidence.state.kind !== "valid" ||
    evidence.state.value !== terminalState ||
    evidence.status.kind !== "valid" ||
    evidence.status.value !== terminalState
  ) {
    return {
      reason: `run-is-not-${terminalState}`,
      runId: expectedRunId,
      status: "refused",
    };
  }
  const marker = evidence.workspaceReleasedAt;
  if (marker.kind !== "valid" && marker.kind !== "absent") {
    return {
      reason: "invalid-release-evidence",
      runId: expectedRunId,
      status: "refused",
    };
  }
  // A marker this call did not write is re-verified on the same full evidence
  // before it is reported as a release: it may have been written by startup
  // GC or an older binary on less evidence, or a process of the run may have
  // appeared since. Its PID-reuse reference is the later of the marker and the
  // last update, as in the launch scan. A launch that never bound tmux (GC's
  // `abandoned-never-bound` handback) has no runtime to probe.
  const neverBound =
    marker.kind === "valid" &&
    manifest.workspaceReleaseKind === "abandoned-never-bound" &&
    !manifest.tmuxSession;
  const reference =
    marker.kind === "valid"
      ? latestInstant(marker.value, manifest.updatedAt)
      : manifest.updatedAt;
  // A legacy manifest that recorded its session but no socket still has a
  // runtime identity: `runtimeAbsent` must then prove the session gone on
  // every socket the launcher could have used. Only the session is required
  // (and, to write a new handback, the workspace binding).
  if (
    !(
      neverBound ||
      (manifest.tmuxSession &&
        (marker.kind === "valid" || manifest.workspaceBinding))
    )
  ) {
    return {
      reason: "missing-runtime-identity",
      runId: expectedRunId,
      status: "refused",
    };
  }
  const processOwner = recordedProcessRefusal(
    manifestPath,
    manifest,
    evidence,
    reference,
    deps
  );
  if (processOwner) {
    return { reason: processOwner, runId: expectedRunId, status: "refused" };
  }
  if (!(neverBound || (await deps.runtimeAbsent(manifestPath)))) {
    return {
      reason: "tmux-runtime-not-absent",
      runId: expectedRunId,
      status: "refused",
    };
  }
  if (marker.kind === "valid") {
    return {
      runId: expectedRunId,
      status: "already-released",
      workspaceReleasedAt: marker.value,
    };
  }
  const releasedAt = deps.now();
  let changed = false;
  const next = updateRunManifest(manifestPath, (current) => {
    // The terminal state is re-checked on the bytes being replaced: `manifest`
    // comes from a second read after the evidence, so matching it alone could
    // force a resumed run back to the terminal state and release its workspace.
    if (
      !(
        current &&
        current.state === terminalState &&
        current.status === terminalState &&
        sameWorkspaceIdentity(current, manifest) &&
        !current.workspaceReleasedAt
      )
    ) {
      return undefined;
    }
    changed = true;
    return {
      ...current,
      state: terminalState,
      status: terminalState,
      updatedAt: releasedAt,
      workspaceReleasedAt: releasedAt,
    };
  });
  if (!(changed && next?.workspaceReleasedAt === releasedAt)) {
    return {
      reason: "manifest-changed-concurrently",
      runId: expectedRunId,
      status: "refused",
    };
  }
  return {
    runId: expectedRunId,
    status: "changed",
    workspaceReleasedAt: releasedAt,
  };
};

const sessionManifestFields = (
  input: RunManifestInput
): Pick<RunManifest, "claudeSessionId" | "codexThreadId" | "ossSessionId"> => ({
  claudeSessionId: input.claudeSessionId ?? "",
  codexThreadId: input.codexThreadId ?? "",
  ossSessionId: input.ossSessionId ?? "",
});

const seatModelManifestFields = (
  value: unknown,
  driver: unknown
): Pick<RunManifest, "seatModels" | "seatModelsDriver"> => {
  if (!isRecord(value)) {
    return {};
  }
  const seatModels: Partial<Record<Agent, string>> = {};
  for (const [agent, model] of Object.entries(value)) {
    if (isAgent(agent) && typeof model === "string" && model.trim()) {
      seatModels[agent] = model.trim();
    }
  }
  if (!Object.keys(seatModels).length) {
    return {};
  }
  return typeof driver === "string" && isAgent(driver)
    ? { seatModels, seatModelsDriver: driver }
    : { seatModels };
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
    ...seatModelManifestFields(input.seatModels, input.seatModelsDriver),
    ...launchReservationManifestFields(input),
    ...worldModelManifestFields(input.worldModel),
    ...(input.claudeChannelServer
      ? { claudeChannelServer: input.claudeChannelServer }
      : {}),
    ...(input.claudeCliVersion
      ? { claudeCliVersion: input.claudeCliVersion }
      : {}),
    ...sessionManifestFields(input),
    ...(input.codexAppServerPid
      ? { codexAppServerPid: input.codexAppServerPid }
      : {}),
    ...(input.codexRemoteUrl ? { codexRemoteUrl: input.codexRemoteUrl } : {}),
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
    ...(input.tmuxSocket ? { tmuxSocket: input.tmuxSocket } : {}),
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
): RunManifest =>
  handbackForState({
    ...manifest,
    status: runStatusFromState(manifest.state),
    updatedAt: now,
  });

export const writeRunManifest = (
  manifestPath: string,
  manifest: RunManifest
): void => {
  ensureParentDir(manifestPath);
  const tempPath = join(
    dirname(manifestPath),
    `.${basename(manifestPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(tempPath, manifestPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
};

// Reads one optional string field under its camelCase and snake_case spellings
// and returns it as a spreadable fragment, so callers stay free of a per-field
// conditional. Absent stays absent rather than becoming an empty string.
const optionalManifestString = <Key extends string>(
  parsed: Record<string, unknown>,
  key: Key,
  aliases: string[]
): Partial<Record<Key, string>> => {
  const value = firstString(parsed, aliases);
  return value ? ({ [key]: value } as Record<Key, string>) : {};
};

// --- Reservation ownership evidence -----------------------------------------
//
// `RunManifest` is a lossy DTO: it drops anything it cannot parse, so a
// present-but-malformed pid and an absent pid arrive identical. Launch
// reservation grants cleanup authority off these fields, and a positive
// verdict off erased evidence is exactly how run 42's workspace was released
// or held wrongly. The representation below keeps presence and validity apart
// so the reservation consumer can refuse instead of guessing.

/** Presence and validity of one ownership field, never collapsed together. */
export type OwnershipField<T> =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly value: T }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "conflicting"; readonly reason: string };

export interface RunOwnershipEvidence {
  /** Optional. Absent is a different fact from present-and-unparseable. */
  readonly launchAttemptPid: OwnershipField<number>;
  /** Mandatory. A run with no canonical pid cannot establish ownership. */
  readonly pid: OwnershipField<number>;
  readonly state: OwnershipField<RunLifecycleState>;
  readonly status: OwnershipField<RunStatus>;
  readonly workspaceReleasedAt: OwnershipField<string>;
}

export type ReservationManifestRead =
  | {
      readonly kind: "valid";
      readonly manifest: RunManifest;
      readonly evidence: RunOwnershipEvidence;
    }
  | {
      readonly kind: "refuse";
      readonly manifestPath: string;
      readonly manifestSha256?: string;
      readonly runId?: string;
      readonly reasons: readonly string[];
    };

const ABSENT_FIELD = { kind: "absent" } as const;

const invalidField = (reason: string): OwnershipField<never> => ({
  kind: "invalid",
  reason,
});

const conflictingField = (reason: string): OwnershipField<never> => ({
  kind: "conflicting",
  reason,
});

/**
 * Presence, decided once for every ownership parser.
 *
 * `readAliasField` calls a parser only when the key is PRESENT, so `undefined`
 * here means non-presence. An explicit `null` is present and unusable, and
 * folding it into `absent` is the presence-collapse this whole boundary exists
 * to prevent: a null release marker would read as "no marker recorded" rather
 * than "marker recorded and untrustworthy", and the reservation would then
 * evaluate the conjunction against evidence it never actually had.
 *
 * Returns the settled field, or `undefined` when the caller must keep parsing.
 */
const presenceOf = <T>(
  value: unknown,
  key: string
): OwnershipField<T> | undefined => {
  if (value === undefined) {
    return ABSENT_FIELD;
  }
  if (value === null) {
    return invalidField(`${key} is present but null`);
  }
  return;
};

// A full canonical positive decimal token. `Number.parseInt` accepts a prefix,
// so it reads "9598junk" as 9598; this never does.
const CANONICAL_PID_RE = /^[1-9][0-9]{0,14}$/u;

const parseCanonicalPid = (
  value: unknown,
  key: string
): OwnershipField<number> => {
  const presence = presenceOf<number>(value, key);
  if (presence) {
    return presence;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0
      ? { kind: "valid", value }
      : invalidField(`${key} is not a positive safe integer`);
  }
  if (typeof value === "string") {
    if (!CANONICAL_PID_RE.test(value)) {
      return invalidField(`${key} is not a canonical positive decimal token`);
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0
      ? { kind: "valid", value: parsed }
      : invalidField(`${key} is not a positive safe integer`);
  }
  return invalidField(`${key} is not a number or decimal string`);
};

/**
 * Reads one logical field across its accepted key spellings. Aliases that
 * disagree are `conflicting`, never silently first-wins; an alias that is
 * present but unparseable is `invalid`, never `absent`.
 */
const readAliasField = <T>(
  parsed: Record<string, unknown>,
  key: string,
  keys: readonly string[],
  parse: (value: unknown, key: string) => OwnershipField<T>
): OwnershipField<T> => {
  let resolved: OwnershipField<T> = ABSENT_FIELD;
  for (const alias of keys) {
    if (!(alias in parsed)) {
      continue;
    }
    const field = parse(parsed[alias], key);
    if (field.kind === "invalid" || field.kind === "conflicting") {
      return field;
    }
    if (field.kind === "absent") {
      continue;
    }
    if (resolved.kind === "valid" && resolved.value !== field.value) {
      return conflictingField(`${key} aliases disagree`);
    }
    resolved = field;
  }
  return resolved;
};

// `Date.parse` accepts "2026-02-30T18:30:00Z" and rolls it to March 2, so the
// only sound check is a component round-trip against the parsed instant.
const UTC_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u;

const parseUtcInstant = (
  value: unknown,
  key: string
): OwnershipField<string> => {
  const presence = presenceOf<string>(value, key);
  if (presence) {
    return presence;
  }
  if (typeof value !== "string") {
    return invalidField(`${key} is not a string`);
  }
  const match = UTC_INSTANT_RE.exec(value);
  if (!match) {
    return invalidField(`${key} is not a UTC instant`);
  }
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const millis = millisecond === undefined ? 0 : Number(millisecond);
  const stamp = Date.UTC(
    parts[0] as number,
    (parts[1] as number) - 1,
    parts[2] as number,
    parts[3] as number,
    parts[4] as number,
    parts[5] as number,
    millis
  );
  const roundTrip = new Date(stamp);
  const sameCalendar =
    roundTrip.getUTCFullYear() === parts[0] &&
    roundTrip.getUTCMonth() + 1 === parts[1] &&
    roundTrip.getUTCDate() === parts[2] &&
    roundTrip.getUTCHours() === parts[3] &&
    roundTrip.getUTCMinutes() === parts[4] &&
    roundTrip.getUTCSeconds() === parts[5] &&
    roundTrip.getUTCMilliseconds() === millis;
  return sameCalendar
    ? { kind: "valid", value }
    : invalidField(`${key} does not round-trip as a calendar date`);
};

const WORKSPACE_RELEASED_AT_KEYS = [
  "workspaceReleasedAt",
  "workspace_released_at",
] as const;

const readWorkspaceReleasedAt = (
  parsed: Record<string, unknown>
): OwnershipField<string> =>
  readAliasField(
    parsed,
    "workspaceReleasedAt",
    WORKSPACE_RELEASED_AT_KEYS,
    parseUtcInstant
  );

const isRunStatus = (value: string): value is RunStatus =>
  value === "running" ||
  value === "done" ||
  value === "failed" ||
  value === "stopped";

const parseStatusField = (
  value: unknown,
  key: string
): OwnershipField<RunStatus> => {
  const presence = presenceOf<RunStatus>(value, key);
  if (presence) {
    return presence;
  }
  if (typeof value !== "string") {
    return invalidField(`${key} is not a string`);
  }
  if (isRunStatus(value)) {
    return { kind: "valid", value };
  }
  // The only legacy spelling the lifecycle mapping already supports.
  if (value === "active") {
    return { kind: "valid", value: "running" };
  }
  return invalidField(`${key} is not an enumerated run status`);
};

const parseStateField = (
  value: unknown,
  key: string
): OwnershipField<RunLifecycleState> => {
  const presence = presenceOf<RunLifecycleState>(value, key);
  if (presence) {
    return presence;
  }
  if (typeof value !== "string") {
    return invalidField(`${key} is not a string`);
  }
  return isRunLifecycleState(value)
    ? { kind: "valid", value }
    : invalidField(`${key} is not an enumerated lifecycle state`);
};

interface LifecycleEvidence {
  readonly state: OwnershipField<RunLifecycleState>;
  readonly status: OwnershipField<RunStatus>;
}

/**
 * A present `state` is authoritative and never falls back to `status`. Only an
 * absent `state` may be supplied by the supported legacy status mapping, and
 * when both are present each must be valid and semantically consistent.
 */
const readLifecycleEvidence = (
  parsed: Record<string, unknown>
): LifecycleEvidence => {
  const state = readAliasField(parsed, "state", ["state"], parseStateField);
  const status = readAliasField(parsed, "status", ["status"], parseStatusField);
  if (state.kind === "invalid" || state.kind === "conflicting") {
    return { state, status };
  }
  if (status.kind === "invalid" || status.kind === "conflicting") {
    return { state, status };
  }
  if (state.kind === "valid" && status.kind === "valid") {
    return runStatusFromState(state.value) === status.value
      ? { state, status }
      : {
          state,
          status: invalidField("status disagrees with state"),
        };
  }
  if (state.kind === "absent" && status.kind === "valid") {
    const mapped = parseRunLifecycleState(undefined, status.value);
    return mapped === undefined
      ? {
          state: invalidField("state is absent and status maps to no state"),
          status,
        }
      : { state: { kind: "valid", value: mapped }, status };
  }
  return { state, status };
};

const fieldRefusal = <T>(field: OwnershipField<T>): string | undefined =>
  field.kind === "invalid" || field.kind === "conflicting"
    ? field.reason
    : undefined;

const optionalWorkspaceReleasedAt = (
  parsed: Record<string, unknown>
): Pick<RunManifest, "workspaceReleasedAt"> | Record<string, never> => {
  const field = readWorkspaceReleasedAt(parsed);
  return field.kind === "valid" ? { workspaceReleasedAt: field.value } : {};
};

const optionalWorkspaceReleaseKind = (
  parsed: Record<string, unknown>
): Pick<RunManifest, "workspaceReleaseKind"> | Record<string, never> =>
  parsed.workspaceReleaseKind === "abandoned-never-bound"
    ? { workspaceReleaseKind: "abandoned-never-bound" }
    : {};

// The supervisor a run serves (`--a2a-as`). The A2A V2 server requires it in
// the manifest before it lets that supervisor claim the run's endpoint, so
// every manifest rewrite must keep it; anything but a supervisor id is
// dropped rather than carried.
const A2A_SUPERVISOR_ID_RE = /^supervisor:[a-z0-9][a-z0-9._-]{0,127}$/u;
const optionalA2ASupervisorId = (
  parsed: Record<string, unknown>
): Pick<RunManifest, "a2aSupervisorId"> | Record<string, never> =>
  typeof parsed.a2aSupervisorId === "string" &&
  A2A_SUPERVISOR_ID_RE.test(parsed.a2aSupervisorId)
    ? { a2aSupervisorId: parsed.a2aSupervisorId }
    : {};

const readOptionalRunManifestFields = (
  parsed: Record<string, unknown>,
  manifestPath: string
): Partial<RunManifest> => {
  const claudeIdentity = {
    ...optionalA2ASupervisorId(parsed),
    ...optionalManifestString(parsed, "claudeChannelServer", [
      "claudeChannelServer",
      "claude_channel_server",
    ]),
    ...optionalManifestString(parsed, "claudeCliVersion", [
      "claudeCliVersion",
      "claude_cli_version",
    ]),
  };
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
  const { socket: tmuxSocket } = readSocketField(parsed);
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
    ...(cavemanMode ? { cavemanMode } : {}),
    ...effortManifestFields({ driverEffort, reviewerEffort }),
    ...seatModelManifestFields(parsed.seatModels, parsed.seatModelsDriver),
    ...claudeIdentity,
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
    ...(tmuxSocket ? { tmuxSocket } : {}),
    ...optionalWorkspaceReleasedAt(parsed),
    ...optionalWorkspaceReleaseKind(parsed),
  };
};

export const readRunManifest = (
  manifestPath: string
): RunManifest | undefined => {
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const raw = readFileSync(manifestPath, "utf8");
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

    return {
      ...readOptionalRunManifestFields(parsed, manifestPath),
      claudeSessionId:
        firstString(parsed, ["claudeSessionId", "claude_session_id"]) ?? "",
      codexThreadId:
        firstString(parsed, ["codexThreadId", "codex_thread_id"]) ?? "",
      createdAt,
      cwd,
      mode,
      ossSessionId:
        firstString(parsed, ["ossSessionId", "oss_session_id"]) ?? "",
      pid,
      repoId,
      runId,
      state: state ?? "working",
      status: state ? runStatusFromState(state) : "running",
      updatedAt,
    };
  } catch {
    return undefined;
  }
};

/**
 * Fail-closed reservation read. Unlike `readRunManifest`, which is a lossy DTO
 * reader, this never answers "absent" for a manifest that exists: a malformed,
 * non-record, unreadable, or ownership-unestablishable file is a refusal
 * sentinel that the caller must carry, because skipping it is a fail-open.
 *
 * Returns `undefined` only when no manifest exists at `manifestPath`.
 */
export const readReservationManifest = (
  manifestPath: string
): ReservationManifestRead | undefined => {
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "refuse",
      manifestPath,
      reasons: [`manifest is unreadable: ${detail}`],
    };
  }
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "refuse",
      manifestPath,
      manifestSha256,
      reasons: [`manifest is not valid JSON: ${detail}`],
    };
  }
  if (!isRecord(parsed)) {
    return {
      kind: "refuse",
      manifestPath,
      manifestSha256,
      reasons: ["manifest is not a JSON record"],
    };
  }
  const runId = firstString(parsed, ["runId", "run_id"]);
  const pid = readAliasField(parsed, "pid", ["pid"], parseCanonicalPid);
  const launchAttemptPid = readAliasField(
    parsed,
    "launchAttemptPid",
    ["launchAttemptPid", "launch_attempt_pid"],
    parseCanonicalPid
  );
  const { state, status } = readLifecycleEvidence(parsed);
  const workspaceReleasedAt = readWorkspaceReleasedAt(parsed);
  const reasons = [
    fieldRefusal(pid),
    fieldRefusal(launchAttemptPid),
    fieldRefusal(state),
    fieldRefusal(status),
    fieldRefusal(workspaceReleasedAt),
    pid.kind === "absent" ? "pid is absent" : undefined,
    state.kind === "absent" ? "state is absent" : undefined,
  ].filter((reason): reason is string => reason !== undefined);
  if (reasons.length > 0) {
    return {
      kind: "refuse",
      manifestPath,
      manifestSha256,
      reasons,
      ...(runId ? { runId } : {}),
    };
  }
  const manifest = readRunManifest(manifestPath);
  if (!manifest) {
    return {
      kind: "refuse",
      manifestPath,
      manifestSha256,
      reasons: ["manifest ownership could not be established"],
      ...(runId ? { runId } : {}),
    };
  }
  return {
    kind: "valid",
    evidence: { launchAttemptPid, pid, state, status, workspaceReleasedAt },
    manifest,
  };
};

/**
 * The seven persisted pane fields. Named once so the atomic clear below and
 * any future consumer read the same list; a hand-maintained second copy is how
 * a pane field gets left behind.
 */
export const TMUX_PANE_MANIFEST_FIELDS = [
  "tmuxPaneAuPair",
  "tmuxPaneGoverness",
  "tmuxPaneLeft",
  "tmuxPaneNanny",
  "tmuxPaneRecon",
  "tmuxPaneRight",
  "tmuxPaneUtility",
] as const;

/**
 * Clears only the seven pane targets, leaving `tmuxSocket` and `tmuxSession`
 * intact. This is the **establish** case: rebinding a session replaces its
 * panes while the run keeps its identity. Reusing the teardown clear below here
 * would blank both identities and recreate the split-brain state.
 *
 * Derived from the same field list as the teardown clear, so a newly added pane
 * field cannot escape either one.
 */
export const clearRunManifestPaneTargets = (): Record<string, undefined> => {
  const cleared: Record<string, undefined> = {};
  for (const field of TMUX_PANE_MANIFEST_FIELDS) {
    cleared[field] = undefined;
  }
  return cleared;
};

/**
 * Clears tmux topology **atomically**: the socket, the session, and all seven
 * pane fields together. A partial clear that leaves a pane target bound to a
 * cleared socket is a new instance of the defect this change exists to close —
 * a pane id is exactly as socket-dependent as a session name.
 */
export const clearRunManifestTmuxTopology = <
  T extends Partial<
    Record<(typeof TMUX_PANE_MANIFEST_FIELDS)[number], unknown>
  >,
>(
  manifest: T
): T => {
  const cleared: Record<string, unknown> = { ...manifest };
  cleared.tmuxSession = undefined;
  cleared.tmuxSocket = undefined;
  for (const field of TMUX_PANE_MANIFEST_FIELDS) {
    cleared[field] = undefined;
  }
  return cleared as T;
};

/**
 * Sole producer of `ManifestHandle`. Reads the manifest bytes once and stamps
 * the handle with the SHA-256 of exactly those bytes, so a handle cannot be
 * minted from a manifest nobody read.
 *
 * `createManifestHandle` must be imported nowhere else; the derived migration
 * check (T-11) asserts that.
 */
export const readRunManifestHandle = (
  manifestPath: string
): ManifestHandle | undefined => {
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const runId = firstString(parsed, ["runId", "run_id"]);
    if (!runId) {
      return undefined;
    }
    const { conflict, socket } = readSocketField(parsed);
    const panes: Record<string, string | string[] | undefined> = {};
    for (const field of TMUX_PANE_MANIFEST_FIELDS) {
      panes[field] =
        field === "tmuxPaneRecon"
          ? firstStringArray(parsed, ["tmuxPaneRecon", "tmux_pane_recon"])
          : firstString(parsed, [field, toSnakeManifestKey(field)]);
    }
    return createManifestHandle({
      manifestPath,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
      panes,
      runId,
      session: firstString(parsed, ["tmuxSession", "tmux_session"]),
      socket,
      socketConflict: conflict,
    });
  } catch {
    return undefined;
  }
};

const toSnakeManifestKey = (key: string): string =>
  key.replace(/([A-Z])/gu, (match) => `_${match.toLowerCase()}`);

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
