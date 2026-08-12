import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import lockfile from "proper-lockfile";
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
import { type TmuxLiveness, tmuxSessionLivenessAsync } from "./tmux-control";
import type { LaunchWorkspaceBinding, Options } from "./types";

const LOCK_FILE = ".paired-launch.lock";
const LOCK_STALE_MS = 5000;

interface LaunchReservationDeps {
  home: string;
  isPidAlive: (pid: number) => boolean;
  makeClaimId: () => string;
  now: () => string;
  pid: number;
  tmuxLiveness: (session: string) => Promise<TmuxLiveness> | TmuxLiveness;
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
  tmuxLiveness: tmuxSessionLivenessAsync,
});

const acquireLock = async (repoDir: string): Promise<() => Promise<void>> => {
  mkdirSync(repoDir, { recursive: true });
  try {
    return await lockfile.lock(repoDir, {
      lockfilePath: join(repoDir, LOCK_FILE),
      realpath: false,
      retries: {
        factor: 1,
        maxTimeout: 25,
        minTimeout: 25,
        randomize: false,
        retries: 200,
      },
      stale: LOCK_STALE_MS,
      update: 1000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[loop] paired launch lock is busy: ${detail}`);
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

// A manifest's `state` is a record written before a crash, not evidence that
// anything survived it. Ownership therefore needs a process that is alive now:
// the bootstrap attempt, or the run pid while the run still claims to be active.
const liveManifestPid = (
  manifest: RunManifest,
  deps: LaunchReservationDeps
): number | undefined =>
  [
    manifest.launchAttemptPid,
    ...(isActiveRunState(manifest.state) ? [manifest.pid] : []),
  ].find((pid): pid is number => Boolean(pid && deps.isPidAlive(pid)));

const manifestCanStillOwnWorkspace = async (
  manifest: RunManifest,
  deps: LaunchReservationDeps
): Promise<boolean> => {
  const tmux = manifest.tmuxSession
    ? await deps.tmuxLiveness(manifest.tmuxSession)
    : "dead";
  if (tmux !== "dead") {
    return true;
  }
  return liveManifestPid(manifest, deps) !== undefined;
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

const storedManifests = async (repoDir: string): Promise<RunManifest[]> => {
  if (!existsSync(repoDir)) {
    return [];
  }
  const manifests: RunManifest[] = [];
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = readRunManifest(
      join(repoDir, entry.name, "manifest.json")
    );
    if (manifest) {
      manifests.push(manifest);
    }
    // proper-lockfile renews on the event loop. Never monopolize it while
    // walking an unbounded run history under the canonical launch lock.
    await yieldToEventLoop();
  }
  return manifests;
};

const assertNoConflict = async (
  manifests: RunManifest[],
  binding: LaunchWorkspaceBinding,
  excludedRunId: string | undefined,
  deps: LaunchReservationDeps
): Promise<void> => {
  for (const manifest of manifests) {
    if (
      manifest.runId === excludedRunId ||
      !(await manifestCanStillOwnWorkspace(manifest, deps))
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

const reserveRequestedLaunch = async (
  opts: Options,
  requested: RunManifest,
  binding: LaunchWorkspaceBinding,
  storage: RunStorage,
  deps: LaunchReservationDeps
): Promise<PairedLaunchClaim> => {
  opts.reservedRunId = requested.runId;
  opts.workspaceBinding = binding;
  if (requested.launchClaimId) {
    opts.launchClaimId = requested.launchClaimId;
  }
  const tmux = requested.tmuxSession
    ? await deps.tmuxLiveness(requested.tmuxSession)
    : "dead";
  if (tmux === "unknown") {
    throw conflictError(requested);
  }
  if (tmux === "live") {
    return { reserved: false, storage, workspaceBinding: binding };
  }
  const liveAttemptPid = liveManifestPid(requested, deps);
  if (liveAttemptPid) {
    throw new Error(
      `[loop] launch conflict: run ${requested.runId} already has a bootstrap attempt owned by live pid ${liveAttemptPid}`
    );
  }
  const attemptId = deps.makeClaimId();
  writeRunManifest(
    storage.manifestPath,
    touchRunManifest(
      {
        ...requested,
        launchAttemptId: attemptId,
        launchAttemptPid: deps.pid,
      },
      deps.now()
    )
  );
  opts.launchAttemptId = attemptId;
  return {
    claimId: attemptId,
    reserved: false,
    storage,
    workspaceBinding: binding,
  };
};

export const reservePairedLaunch = async (
  opts: Options,
  binding: LaunchWorkspaceBinding,
  overrides: Partial<LaunchReservationDeps> = {}
): Promise<PairedLaunchClaim> => {
  const deps = { ...defaultDeps(), ...overrides };
  const repoDir = join(resolveStorageRoot(deps.home), binding.repoId);
  const releaseLock = await acquireLock(repoDir);
  try {
    const manifests = await storedManifests(repoDir);
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
    await assertNoConflict(manifests, effectiveBinding, requestedRunId, deps);
    if (requestedRunId && requested) {
      const storage = resolveRunStorage(
        requestedRunId,
        effectiveBinding.root,
        deps.home
      );
      return await reserveRequestedLaunch(
        opts,
        requested,
        effectiveBinding,
        storage,
        deps
      );
    }

    const storage = reserveRunStorage(binding.root, deps.home);
    const claimId = deps.makeClaimId();
    const manifest = createRunManifest(
      {
        claudeSessionId: "",
        codexThreadId: "",
        cwd: binding.root,
        launchAttemptId: claimId,
        launchAttemptPid: deps.pid,
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
    opts.launchAttemptId = claimId;
    opts.launchClaimId = claimId;
    opts.reservedRunId = storage.runId;
    opts.workspaceBinding = binding;
    return { claimId, reserved: true, storage, workspaceBinding: binding };
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[loop] paired launch lock release failed; stale recovery will retry: ${detail}\n`
      );
    }
  }
};

export const bindLaunchTask = (
  claim: PairedLaunchClaim,
  task: string,
  now = new Date().toISOString()
): string => {
  const sha256 = createHash("sha256").update(task).digest("hex");
  updateRunManifest(claim.storage.manifestPath, (manifest) => {
    if (!manifest) {
      throw new Error(`[loop] run ${claim.storage.runId} no longer exists`);
    }
    if (claim.claimId && manifest.launchAttemptId !== claim.claimId) {
      throw new Error(
        `[loop] launch attempt ${claim.claimId} no longer owns run ${claim.storage.runId}`
      );
    }
    if (manifest.sourceTaskSha256 && manifest.sourceTaskSha256 !== sha256) {
      throw new Error(
        `[loop] run ${manifest.runId} is already bound to a different source charter`
      );
    }
    if (!claim.claimId) {
      return manifest;
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
    if (manifest?.launchAttemptId !== claim.claimId) {
      return manifest;
    }
    const released = {
      ...manifest,
      launchAttemptId: undefined,
      launchAttemptPid: undefined,
    };
    if (!claim.reserved) {
      return touchRunManifest(released, now);
    }
    if (manifest.tmuxSession || !isActiveRunState(manifest.state)) {
      return released;
    }
    return setRunManifestState(released, "failed", now);
  });
};

export const launchReservationInternals = {
  acquireLock,
  assertNoConflict,
  defaultPidLiveness,
  manifestCanStillOwnWorkspace,
  workspaceConflict,
};
