import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createRunManifest,
  isActiveRunState,
  type RunManifest,
  type RunStorage,
  readRunManifest,
  reserveRunStorage,
  resolveExistingRunId,
  resolveRunStorage,
  resolveStorageRoot,
  setRunManifestState,
  touchRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "./run-state";
import { type TmuxLiveness, tmuxSessionLiveness } from "./tmux-control";
import type { LaunchWorkspaceBinding, Options } from "./types";

const LOCK_FILE = ".paired-launch.lock";
const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 25;
const RUN_ID_RE = /^\d+$/u;

interface LaunchLockRecord {
  claimId: string;
  pid: number;
}

interface LaunchReservationDeps {
  home: string;
  isPidAlive: (pid: number) => boolean;
  makeClaimId: () => string;
  now: () => string;
  pid: number;
  sleep: (ms: number) => Promise<void>;
  tmuxLiveness: (session: string) => TmuxLiveness;
}

export interface PairedLaunchClaim {
  claimId?: string;
  reserved: boolean;
  storage: RunStorage;
  workspaceBinding: LaunchWorkspaceBinding;
}

const defaultPidLiveness = (pid: number): boolean => {
  if (!(Number.isInteger(pid) && pid > 0)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultDeps = (): LaunchReservationDeps => ({
  home: process.env.HOME ?? "",
  isPidAlive: defaultPidLiveness,
  makeClaimId: randomUUID,
  now: () => new Date().toISOString(),
  pid: process.pid,
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  tmuxLiveness: tmuxSessionLiveness,
});

const isAlreadyExists = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

const readLock = (path: string): LaunchLockRecord | undefined => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!(typeof parsed === "object" && parsed !== null)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.claimId === "string" &&
      typeof record.pid === "number" &&
      Number.isInteger(record.pid)
      ? { claimId: record.claimId, pid: record.pid }
      : undefined;
  } catch {
    return undefined;
  }
};

const releaseLock = (path: string, claimId: string): void => {
  if (readLock(path)?.claimId !== claimId) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    // A lock owner may race only with stale-lock recovery. Never broaden cleanup.
  }
};

const acquireLock = async (
  repoDir: string,
  deps: LaunchReservationDeps
): Promise<{ claimId: string; path: string }> => {
  mkdirSync(repoDir, { recursive: true });
  const path = join(repoDir, LOCK_FILE);
  const claimId = deps.makeClaimId();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      writeFileSync(path, `${JSON.stringify({ claimId, pid: deps.pid })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { claimId, path };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      const owner = readLock(path);
      if (owner && !deps.isPidAlive(owner.pid)) {
        releaseLock(path, owner.claimId);
        continue;
      }
      if (Date.now() >= deadline) {
        const detail = owner
          ? ` owned by live pid ${owner.pid}`
          : " unreadable";
        throw new Error(`[loop] paired launch lock is busy:${detail}`);
      }
      await deps.sleep(LOCK_POLL_MS);
    }
  }
};

const workspaceConflict = (
  left: LaunchWorkspaceBinding,
  right: LaunchWorkspaceBinding
): boolean =>
  left.root === right.root ||
  Boolean(
    left.branchRef && right.branchRef && left.branchRef === right.branchRef
  );

const manifestCanStillOwnWorkspace = (
  manifest: RunManifest,
  deps: LaunchReservationDeps
): boolean => {
  const tmux = manifest.tmuxSession
    ? deps.tmuxLiveness(manifest.tmuxSession)
    : "dead";
  if (tmux !== "dead") {
    return true;
  }
  return isActiveRunState(manifest.state);
};

const conflictError = (manifest: RunManifest): Error => {
  const binding = manifest.workspaceBinding;
  const session = manifest.tmuxSession ?? "not-yet-bound";
  const root = binding?.root ?? manifest.cwd;
  const branch = binding?.branchRef ?? "legacy-unknown";
  return new Error(
    `[loop] launch conflict: run ${manifest.runId} (${session}) still owns workspace ${root} on ${branch}; resume or stop that run before launching another`
  );
};

const storedManifests = (repoDir: string): RunManifest[] => {
  if (!existsSync(repoDir)) {
    return [];
  }
  return readdirSync(repoDir)
    .filter((entry) => RUN_ID_RE.test(entry))
    .map((runId) => readRunManifest(join(repoDir, runId, "manifest.json")))
    .filter((manifest): manifest is RunManifest => Boolean(manifest));
};

const assertNoConflict = (
  manifests: RunManifest[],
  binding: LaunchWorkspaceBinding,
  excludedRunId: string | undefined,
  deps: LaunchReservationDeps
): void => {
  for (const manifest of manifests) {
    if (
      manifest.runId === excludedRunId ||
      !manifestCanStillOwnWorkspace(manifest, deps)
    ) {
      continue;
    }
    if (!manifest.workspaceBinding) {
      throw conflictError(manifest);
    }
    if (workspaceConflict(manifest.workspaceBinding, binding)) {
      throw conflictError(manifest);
    }
  }
};

const resolveRequestedRun = (
  opts: Options,
  binding: LaunchWorkspaceBinding,
  home: string
): string | undefined => {
  const selector = opts.resumeRunId ?? opts.sessionId;
  return selector
    ? resolveExistingRunId(selector, binding.root, home)
    : undefined;
};

const validateExplicitWorkspaceResume = (
  opts: Options,
  requested: RunManifest,
  binding: LaunchWorkspaceBinding
): LaunchWorkspaceBinding => {
  const stored = requested.workspaceBinding;
  if (!(opts.workspace && stored)) {
    return stored ?? binding;
  }
  if (stored.root !== binding.root || stored.branchRef !== binding.branchRef) {
    throw new Error(
      `[loop] run ${requested.runId} is bound to ${stored.root} on ${stored.branchRef ?? "detached"}, not ${binding.root} on ${binding.branchRef ?? "detached"}`
    );
  }
  return stored;
};

export const reservePairedLaunch = async (
  opts: Options,
  binding: LaunchWorkspaceBinding,
  overrides: Partial<LaunchReservationDeps> = {}
): Promise<PairedLaunchClaim> => {
  const deps = { ...defaultDeps(), ...overrides };
  const repoDir = join(resolveStorageRoot(deps.home), binding.repoId);
  const lock = await acquireLock(repoDir, deps);
  try {
    const manifests = storedManifests(repoDir);
    const requestedRunId = resolveRequestedRun(opts, binding, deps.home);
    const requested = requestedRunId
      ? readRunManifest(
          resolveRunStorage(requestedRunId, binding.root, deps.home)
            .manifestPath
        )
      : undefined;
    if ((opts.resumeRunId || requestedRunId) && !requested) {
      throw new Error(
        `[loop] paired run "${opts.resumeRunId ?? opts.sessionId}" does not exist`
      );
    }
    const effectiveBinding = requested
      ? validateExplicitWorkspaceResume(opts, requested, binding)
      : binding;
    assertNoConflict(manifests, effectiveBinding, requestedRunId, deps);
    if (requestedRunId && requested) {
      const storage = resolveRunStorage(
        requestedRunId,
        effectiveBinding.root,
        deps.home
      );
      opts.reservedRunId = requestedRunId;
      opts.workspaceBinding = effectiveBinding;
      return {
        reserved: false,
        storage,
        workspaceBinding: effectiveBinding,
      };
    }

    const storage = reserveRunStorage(binding.root, deps.home);
    const claimId = deps.makeClaimId();
    const manifest = createRunManifest(
      {
        claudeSessionId: "",
        codexThreadId: "",
        cwd: binding.root,
        launchClaimId: claimId,
        mode: "paired",
        pid: deps.pid,
        repoId: storage.repoId,
        runId: storage.runId,
        state: "submitted",
        workspaceBinding: binding,
      },
      deps.now()
    );
    writeRunManifest(storage.manifestPath, manifest);
    opts.launchClaimId = claimId;
    opts.reservedRunId = storage.runId;
    opts.workspaceBinding = binding;
    return { claimId, reserved: true, storage, workspaceBinding: binding };
  } finally {
    releaseLock(lock.path, lock.claimId);
  }
};

export const bindLaunchTask = (
  claim: PairedLaunchClaim,
  task: string,
  now = new Date().toISOString()
): string => {
  const sha256 = createHash("sha256").update(task).digest("hex");
  if (!claim.claimId) {
    return sha256;
  }
  updateRunManifest(claim.storage.manifestPath, (manifest) => {
    if (manifest?.launchClaimId !== claim.claimId) {
      throw new Error(
        `[loop] launch claim ${claim.claimId} no longer owns run ${claim.storage.runId}`
      );
    }
    if (manifest.sourceTaskSha256 && manifest.sourceTaskSha256 !== sha256) {
      throw new Error(
        `[loop] run ${manifest.runId} is already bound to a different source charter`
      );
    }
    return touchRunManifest({ ...manifest, sourceTaskSha256: sha256 }, now);
  });
  return sha256;
};

export const cancelPairedLaunch = (
  claim: PairedLaunchClaim,
  now = new Date().toISOString()
): void => {
  if (!claim.claimId) {
    return;
  }
  updateRunManifest(claim.storage.manifestPath, (manifest) => {
    if (
      manifest?.launchClaimId !== claim.claimId ||
      manifest.tmuxSession ||
      !isActiveRunState(manifest.state)
    ) {
      return manifest;
    }
    return setRunManifestState(manifest, "failed", now);
  });
};

export const launchReservationInternals = {
  acquireLock,
  assertNoConflict,
  defaultPidLiveness,
  manifestCanStillOwnWorkspace,
  releaseLock,
  workspaceConflict,
};
