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
  readRunManifestHandle,
  reserveRunStorage,
  resolveExistingRunId,
  resolveRunStorage,
  resolveStorageRoot,
  setRunManifestState,
  touchRunManifest,
  updateRunManifest,
  writeRunManifest,
} from "./run-state";
import { type TmuxLiveness, tmuxTargetLivenessAsync } from "./tmux-control";
import {
  manifestSocketState,
  resolveTmuxSocket,
  type TmuxSkipSink,
  type TmuxTarget,
  targetFromManifest,
} from "./tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "./types";

const LOCK_FILE = ".paired-launch.lock";
const LOCK_STALE_MS = 5000;
const defaultTmuxSkipSink: TmuxSkipSink = { record: () => undefined };

type ManifestHandle = NonNullable<ReturnType<typeof readRunManifestHandle>>;

interface LaunchReservationDeps {
  /**
   * Environment consulted for socket resolution. Injected rather than read from
   * `process.env` at the call site so a test can drive resolution without
   * mutating the ambient environment of the whole suite.
   */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  isPidAlive: (pid: number) => boolean;
  makeClaimId: () => string;
  now: () => string;
  pid: number;
  /**
   * Injected so a test can count invocations and prove the resume path never
   * consults it. Post-launch paths must read the persisted manifest target, so
   * a resolver call on resume is itself the defect, not just its result.
   */
  resolveSocket: (
    env: Readonly<Record<string, string | undefined>>,
    uid: number
  ) => string;
  skipSink: TmuxSkipSink;
  tmuxLiveness: (
    target: TmuxTarget | undefined
  ) => Promise<TmuxLiveness> | TmuxLiveness;
  uid: number;
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
  env: process.env,
  home: process.env.HOME ?? "",
  isPidAlive: defaultPidLiveness,
  makeClaimId: randomUUID,
  now: () => new Date().toISOString(),
  pid: process.pid,
  resolveSocket: (env, uid) => resolveTmuxSocket(env, { uid }).socket,
  skipSink: defaultTmuxSkipSink,
  tmuxLiveness: tmuxTargetLivenessAsync,
  uid: process.getuid?.() ?? 0,
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

const manifestCanStillOwnWorkspace = async (
  manifest: RunManifest,
  handle: ManifestHandle | undefined,
  target: TmuxTarget | undefined,
  deps: LaunchReservationDeps
): Promise<boolean> => {
  if (!target) {
    deps.skipSink.record({
      consumer: "launch-reservation.manifestCanStillOwnWorkspace",
      effectSkipped: "release-workspace-ownership",
      pane: null,
      reason: "manifest target is unavailable; preserving workspace ownership",
      runId: manifest.runId,
      session: manifest.tmuxSession ?? null,
      socketState: handle ? manifestSocketState(handle) : "unknown",
    });
    return true;
  }
  const tmux = await deps.tmuxLiveness(target);
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

interface StoredManifest {
  handle: ManifestHandle | undefined;
  manifest: RunManifest;
  target: TmuxTarget | undefined;
}

const storedManifests = async (repoDir: string): Promise<StoredManifest[]> => {
  if (!existsSync(repoDir)) {
    return [];
  }
  const manifests: StoredManifest[] = [];
  for (const entry of readdirSync(repoDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = join(repoDir, entry.name, "manifest.json");
    const manifest = readRunManifest(manifestPath);
    if (manifest) {
      const handle = readRunManifestHandle(manifestPath);
      manifests.push({
        handle,
        manifest,
        target: handle ? targetFromManifest(handle) : undefined,
      });
    }
    // proper-lockfile renews on the event loop. Never monopolize it while
    // walking an unbounded run history under the canonical launch lock.
    await yieldToEventLoop();
  }
  return manifests;
};

const assertNoConflict = async (
  manifests: StoredManifest[],
  binding: LaunchWorkspaceBinding,
  excludedRunId: string | undefined,
  deps: LaunchReservationDeps
): Promise<void> => {
  for (const { handle, manifest, target } of manifests) {
    if (
      manifest.runId === excludedRunId ||
      !(await manifestCanStillOwnWorkspace(manifest, handle, target, deps))
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
  const handle = readRunManifestHandle(storage.manifestPath);
  const target = handle ? targetFromManifest(handle) : undefined;
  if (!target) {
    deps.skipSink.record({
      consumer: "launch-reservation.reserveRequestedLaunch",
      effectSkipped: "reserve-requested-launch",
      pane: null,
      reason:
        "requested manifest target is unavailable; refusing launch reservation",
      runId: requested.runId,
      session: requested.tmuxSession ?? null,
      socketState: handle ? manifestSocketState(handle) : "unknown",
    });
    throw conflictError(requested);
  }
  const tmux = await deps.tmuxLiveness(target);
  if (tmux === "unknown") {
    throw conflictError(requested);
  }
  opts.reservedRunId = requested.runId;
  opts.workspaceBinding = binding;
  if (requested.launchClaimId) {
    opts.launchClaimId = requested.launchClaimId;
  }
  if (tmux === "live") {
    return { reserved: false, storage, workspaceBinding: binding };
  }
  const liveAttemptPid = [
    requested.launchAttemptPid,
    ...(isActiveRunState(requested.state) ? [requested.pid] : []),
  ].find((pid): pid is number => Boolean(pid && deps.isPidAlive(pid)));
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
  // Socket resolution is a LAUNCH-ONLY act. A resume must target the socket its
  // manifest already records, so the resolver has to stay unreachable from that
  // path (R6, verify 5a) — otherwise hostile ambient state does not merely get
  // ignored, it throws and takes a legitimate resume down with it.
  let resolvedSocket: string | undefined;
  const launchSocket = (): string => {
    resolvedSocket ??= deps.resolveSocket(deps.env, deps.uid);
    return resolvedSocket;
  };
  // An unambiguously fresh launch resolves before the lock, before storage
  // reservation, and before any tmux contact (verify 2, 4): a throw here has
  // nothing to unwind, since no lock is held and no manifest exists. A launch
  // that names a run is a resume request and must not resolve at all; if it
  // still turns out to be fresh, the call below resolves it before reservation.
  if (!(opts.resumeRunId || opts.sessionId)) {
    launchSocket();
  }
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
    // Latest possible resolution point for EVERY fresh path. The pre-lock call
    // covers only the unnamed case; a launch that named a run which does not
    // exist also lands on the fresh branch below. This must precede
    // `assertNoConflict`, which contacts tmux through `tmuxLiveness`, and
    // `reserveRunStorage`, which creates a run directory — otherwise an
    // unusable socket leaves a reserved run behind (verify 2, 4).
    if (!requested) {
      launchSocket();
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
        tmuxSocket: launchSocket(),
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
