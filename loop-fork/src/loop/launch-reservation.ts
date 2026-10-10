import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { platform as osPlatform } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { resolveLaunchModel } from "./launch-defaults";
import { groupCanStillOwnRun, processGroupAlive } from "./process-group";
import {
  defaultPidLiveness,
  defaultPidStartedAt,
  pidCanStillOwnRun,
} from "./pid-ownership";
import {
  auxiliaryProcessOwnership,
  createRunManifest,
  isActiveRunState,
  latestInstant,
  type ReservationManifestRead,
  type RunManifest,
  type RunOwnershipEvidence,
  type RunStorage,
  readReservationManifest,
  readRunManifest,
  readRunManifestHandle,
  reconcileLegacyStoppedRun,
  reserveRunStorage,
  resolveExistingRunId,
  resolveRunStorage,
  resolveStorageRoot,
  setRunManifestState,
  touchRunManifest,
  updateRunManifest,
  withoutWorkspaceHandback,
  writeRunManifest,
} from "./run-state";
import {
  type TmuxLiveness,
  tmuxTargetLiveness,
  tmuxTargetLivenessAsync,
} from "./tmux-control";
import {
  legacyCandidateTargetsFromManifest,
  type ManifestHandle,
  readTmuxEndpointState,
  resolveTmuxSocket,
  type TmuxEndpointState,
  type TmuxTarget,
  targetFromManifest,
} from "./tmux-socket";
import type { LaunchWorkspaceBinding, Options } from "./types";

const LOCK_FILE = ".paired-launch.lock";
const LOCK_STALE_MS = 5000;

interface LaunchReservationDeps {
  /**
   * Classifies a target's socket endpoint. Injected so a test can fake the
   * filesystem fact without depending on which sockets exist on the host.
   */
  endpointState: (target: TmuxTarget | undefined) => TmuxEndpointState;
  /**
   * Environment consulted for socket resolution. Injected rather than read from
   * `process.env` at the call site so a test can drive resolution without
   * mutating the ambient environment of the whole suite.
   */
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  isPidAlive: (pid: number) => boolean;
  /** One line per run the launch released on full evidence. */
  log: (line: string) => void;
  makeClaimId: () => string;
  now: () => string;
  pid: number;
  pidStartedAt: (pid: number) => number | undefined;
  /** Platform for the legacy socket candidate set and its byte budget. */
  platform: string;
  /** Whether any process is a member of the group (see `process-group`). */
  processGroupAlive: (pgid: number) => boolean;
  /**
   * Injected so a test can count invocations and prove the resume path never
   * consults it. Post-launch paths must read the persisted manifest target, so
   * a resolver call on resume is itself the defect, not just its result.
   */
  resolveSocket: (
    env: Readonly<Record<string, string | undefined>>,
    uid: number
  ) => string;
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

const defaultDeps = (): LaunchReservationDeps => ({
  endpointState: readTmuxEndpointState,
  env: process.env,
  home: process.env.HOME ?? "",
  isPidAlive: defaultPidLiveness,
  log: (line) => {
    process.stderr.write(`${line}\n`);
  },
  pidStartedAt: defaultPidStartedAt,
  processGroupAlive,
  makeClaimId: randomUUID,
  now: () => new Date().toISOString(),
  pid: process.pid,
  platform: osPlatform(),
  resolveSocket: (env, uid) => resolveTmuxSocket(env, { uid }).socket,
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

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "stopped"]);

/**
 * Is the run's tmux runtime positively gone?
 *
 * Endpoint absence was only ever a PROXY for "the server that owned this
 * session is gone", and run 42 made the proxy look exact because its socket
 * file happened to be gone too. Run 61 breaks it: the session
 * `agents-collab-loop-61` is positively absent, but its socket is the shared
 * default that other live sessions still hold, so the endpoint is present
 * forever and the run could never be released.
 *
 * Two branches, and only two, are positive proof:
 *   - the endpoint is gone AND liveness cannot be established through it; or
 *   - the endpoint is reachable AND the exact branded target answers `dead`,
 *     which is the stronger fact the proxy was standing in for.
 *
 * Everything else blocks. `unknown` endpoint is never absence. `live` tmux is
 * never absence. `present` + `unknown` means a reachable socket that will not
 * answer about this session, so we learned nothing. `absent` + `live`/`dead`
 * blocks because with no socket the verdict cannot have been obtained through
 * the bound endpoint, so it is not evidence about this run.
 */
export const runtimeAbsent = (
  endpoint: TmuxEndpointState,
  tmux: TmuxLiveness
): boolean =>
  (endpoint === "absent" && tmux === "unknown") ||
  (endpoint === "present" && tmux === "dead");

type ReleaseVerdict =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: string };

const refused = (reason: string): ReleaseVerdict => ({
  granted: false,
  reason,
});
const GRANTED: ReleaseVerdict = { granted: true };

type RuntimeProbeDeps = Pick<
  LaunchReservationDeps,
  "endpointState" | "env" | "platform" | "tmuxLiveness" | "uid"
>;

/**
 * A manifest that recorded its tmux session but no socket at all. Its session
 * was created on whichever server plain `tmux` discovered at the time, so it
 * is gone only when it is positively gone from EVERY candidate server (see
 * `legacyTmuxSocketCandidates`). Each candidate is judged by the same
 * `runtimeAbsent` rule as a recorded socket; any `live` or `unknown` answer on
 * any candidate keeps the run owning.
 */
const legacyRuntimeAbsent = async (
  handle: ManifestHandle,
  deps: RuntimeProbeDeps
): Promise<boolean> => {
  const targets = legacyCandidateTargetsFromManifest(handle, {
    env: deps.env,
    platform: deps.platform,
    uid: deps.uid,
  });
  if (!targets?.length) {
    return false;
  }
  for (const target of targets) {
    const endpoint = deps.endpointState(target);
    if (!runtimeAbsent(endpoint, await deps.tmuxLiveness(target))) {
      return false;
    }
  }
  return true;
};

/**
 * Is this run's tmux runtime positively gone? One rule for both the launch
 * scan and `loop reconcile`: the recorded socket when there is one, else every
 * legacy candidate socket. An unreadable manifest, an invalid or conflicting
 * socket, or no session at all is never absence.
 */
export const tmuxRuntimeAbsentForManifest = async (
  manifestPath: string,
  overrides: Partial<LaunchReservationDeps> = {}
): Promise<boolean> => {
  const deps = { ...defaultDeps(), ...overrides };
  const handle = readRunManifestHandle(manifestPath);
  if (!handle) {
    return false;
  }
  const target = targetFromManifest(handle);
  if (target) {
    return runtimeAbsent(
      deps.endpointState(target),
      await deps.tmuxLiveness(target)
    );
  }
  return await legacyRuntimeAbsent(handle, deps);
};

export interface SyncRuntimeProbeDeps {
  endpointState: (target: TmuxTarget | undefined) => TmuxEndpointState;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  tmuxLiveness: (target: TmuxTarget | undefined) => TmuxLiveness;
  uid: number;
}

/**
 * The synchronous form of `tmuxRuntimeAbsentForManifest`, with the same rule:
 * the recorded socket when there is one, else every legacy candidate socket,
 * each judged by `runtimeAbsent`. For startup GC, which must not judge a run
 * gone from the current tmux server's session list alone.
 */
export const tmuxRuntimeAbsentForManifestSync = (
  manifestPath: string,
  overrides: Partial<SyncRuntimeProbeDeps> = {}
): boolean => {
  const deps: SyncRuntimeProbeDeps = {
    endpointState: readTmuxEndpointState,
    env: process.env,
    platform: osPlatform(),
    tmuxLiveness: (target) => tmuxTargetLiveness(target),
    uid: process.getuid?.() ?? 0,
    ...overrides,
  };
  const handle = readRunManifestHandle(manifestPath);
  if (!handle) {
    return false;
  }
  const target = targetFromManifest(handle);
  const targets = target
    ? [target]
    : legacyCandidateTargetsFromManifest(handle, {
        env: deps.env,
        platform: deps.platform,
        uid: deps.uid,
      });
  if (!targets?.length) {
    return false;
  }
  return targets.every((candidate) =>
    runtimeAbsent(deps.endpointState(candidate), deps.tmuxLiveness(candidate))
  );
};

const neverBoundShape = (manifest: RunManifest): boolean =>
  manifest.workspaceReleaseKind === "abandoned-never-bound" &&
  !manifest.tmuxSession &&
  !manifest.tmuxPaneLeft &&
  !manifest.tmuxPaneRight &&
  !manifest.tmuxPaneGoverness &&
  !manifest.tmuxPaneAuPair &&
  !manifest.tmuxPaneNanny &&
  !manifest.tmuxPaneRecon?.length;

interface StoredRun {
  handle: ManifestHandle | undefined;
  manifestPath: string;
}

/**
 * Why a recorded process may still belong to the run, or `undefined` when
 * every one (run pid, launch-attempt pid, app-server, bridge worker, each
 * `run-processes/` entry, and each claimed utility job's worker) is positively
 * dead or provably a later process.
 */
const recordedProcessOwnership = (
  manifest: RunManifest,
  evidence: RunOwnershipEvidence,
  reference: string,
  deps: LaunchReservationDeps,
  stored: StoredRun | undefined
): string | undefined => {
  if (
    evidence.pid.kind !== "valid" ||
    pidCanStillOwnRun(evidence.pid.value, reference, deps)
  ) {
    return `its pid ${manifest.pid} may still be running`;
  }
  const attempt = evidence.launchAttemptPid;
  if (attempt.kind === "invalid" || attempt.kind === "conflicting") {
    return "its launch-attempt pid is unreadable";
  }
  if (
    attempt.kind === "valid" &&
    pidCanStillOwnRun(attempt.value, reference, deps)
  ) {
    return `its launch-attempt pid ${attempt.value} may still be running`;
  }
  return stored
    ? auxiliaryProcessOwnership(
        stored.manifestPath,
        manifest,
        reference,
        (pid, at) => pidCanStillOwnRun(pid, at, deps),
        (pgid, at) => groupCanStillOwnRun(pgid, at, deps)
      )
    : undefined;
};

/**
 * The terminal-released conjunction. Every conjunct must hold positively;
 * anything else keeps the workspace owned. Run 42 sat here forever: its tmux
 * endpoint was gone, so liveness could only answer "unknown", and unknown was
 * read as ownership with no way to ever release. Release is granted only on
 * positive evidence that the endpoint is gone AND the run recorded an explicit
 * handback AND no recorded PID can still identify the pre-handback process. A
 * live but positively post-release reused PID is not ownership.
 *
 * The PID-reuse reference is the later of the release marker and the last
 * manifest update, so a hand-edited marker back-dated before the run's last
 * recorded activity cannot make a live run process look unrelated.
 */
const terminalReleaseVerdict = async (
  manifest: RunManifest,
  evidence: RunOwnershipEvidence,
  target: TmuxTarget | undefined,
  tmux: TmuxLiveness,
  deps: LaunchReservationDeps,
  stored?: StoredRun
): Promise<ReleaseVerdict> => {
  if (
    evidence.state.kind !== "valid" ||
    !TERMINAL_RUN_STATES.has(evidence.state.value)
  ) {
    return refused(
      `it is ${manifest.state}, not stopped, failed, or completed`
    );
  }
  if (
    evidence.status.kind === "invalid" ||
    evidence.status.kind === "conflicting"
  ) {
    return refused("its status is unreadable");
  }
  if (evidence.workspaceReleasedAt.kind !== "valid") {
    return refused("it never recorded a workspace handback");
  }
  const processOwner = recordedProcessOwnership(
    manifest,
    evidence,
    latestInstant(evidence.workspaceReleasedAt.value, manifest.updatedAt),
    deps,
    stored
  );
  if (processOwner) {
    return refused(processOwner);
  }
  // Runtime absence is the last conjunct, evaluated only once every ownership
  // fact above has been established positively.
  if (target) {
    return runtimeAbsent(deps.endpointState(target), tmux)
      ? GRANTED
      : refused(`tmux session ${manifest.tmuxSession} is not positively gone`);
  }
  if (neverBoundShape(manifest)) {
    return GRANTED;
  }
  if (manifest.tmuxSession && stored?.handle) {
    return (await legacyRuntimeAbsent(stored.handle, deps))
      ? GRANTED
      : refused(
          `tmux session ${manifest.tmuxSession} (no recorded socket) is not positively gone from every candidate socket`
        );
  }
  return refused("its tmux runtime cannot be addressed");
};

const ownershipVerdict = async (
  manifest: RunManifest,
  target: TmuxTarget | undefined,
  deps: LaunchReservationDeps,
  evidence?: RunOwnershipEvidence,
  stored?: StoredRun
): Promise<ReleaseVerdict> => {
  const tmux = manifest.tmuxSession ? await deps.tmuxLiveness(target) : "dead";
  if (evidence) {
    // Evidence-backed scan. The conjunction is the ONLY route to release: a
    // failed conjunct must not fall through to the older dead-tmux rule, which
    // would release a terminal run that never recorded an explicit handback.
    return await terminalReleaseVerdict(
      manifest,
      evidence,
      target,
      tmux,
      deps,
      stored
    );
  }
  // Legacy callers that supply no ownership evidence keep the prior verdict.
  if (tmux !== "dead") {
    return refused("its tmux session is not dead");
  }
  return isActiveRunState(manifest.state)
    ? refused(`it is ${manifest.state}`)
    : GRANTED;
};

const manifestCanStillOwnWorkspace = async (
  manifest: RunManifest,
  target: TmuxTarget | undefined,
  deps: LaunchReservationDeps,
  evidence?: RunOwnershipEvidence,
  stored?: StoredRun
): Promise<boolean> =>
  !(await ownershipVerdict(manifest, target, deps, evidence, stored)).granted;

const reconcileKind = (state: string): string | undefined => {
  if (state === "stopped") {
    return "stopped-run";
  }
  if (state === "failed") {
    return "failed-terminal";
  }
  return undefined;
};

/** The exact command that resolves a conflict with this run, when one exists. */
const resolution = (manifest: RunManifest): string => {
  const kind = reconcileKind(manifest.state);
  if (kind && !manifest.workspaceReleasedAt) {
    // `loop reconcile` refuses a run with no recorded binding or session
    // (missing-runtime-identity), so naming it would send the operator to a
    // command that cannot succeed.
    if (!(manifest.workspaceBinding && manifest.tmuxSession)) {
      return `run ${manifest.runId} recorded no workspace binding or tmux session, so no \`loop reconcile\` command can prove it gone; it needs an owner decision`;
    }
    return `once nothing of run ${manifest.runId} is still running, run \`loop reconcile ${kind} ${manifest.runId}\``;
  }
  if (isActiveRunState(manifest.state)) {
    return `resume it with \`loop --tmux --run-id ${manifest.runId}\`, or stop it before launching another`;
  }
  return `stop whatever of run ${manifest.runId} is still running, then launch again`;
};

const conflictError = (manifest: RunManifest, reason?: string): Error => {
  const binding = manifest.workspaceBinding;
  const session = manifest.tmuxSession ?? "not-yet-bound";
  const root = binding?.root ?? manifest.cwd;
  const branch = binding?.branchRef ?? "legacy-unknown";
  const why = reason ? ` (${reason})` : "";
  return new Error(
    `[loop] launch conflict: run ${manifest.runId} (${session}) still owns workspace ${root} on ${branch}${why}; ${resolution(manifest)}`
  );
};

interface StoredManifest extends StoredRun {
  read: ReservationManifestRead;
  target: TmuxTarget | undefined;
}

const refusalError = (
  refusal: Extract<ReservationManifestRead, { kind: "refuse" }>
): Error =>
  new Error(
    `[loop] launch conflict: run ${refusal.runId ?? "unknown"} at ${refusal.manifestPath} still owns workspace because its ownership evidence cannot be read (${refusal.reasons.join("; ")}); repair or remove that manifest before launching another`
  );

/**
 * Every existing manifest is retained, refusals included. Dropping a manifest
 * we could not read is a fail-open: the reservation then allocates a run into
 * a workspace whose owner it never established.
 */
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
    const read = readReservationManifest(manifestPath);
    if (read) {
      const handle =
        read.kind === "valid" ? readRunManifestHandle(manifestPath) : undefined;
      manifests.push({
        handle,
        manifestPath,
        read,
        target: handle ? targetFromManifest(handle) : undefined,
      });
    }
    // proper-lockfile renews on the event loop. Never monopolize it while
    // walking an unbounded run history under the canonical launch lock.
    await yieldToEventLoop();
  }
  return manifests;
};

/**
 * A stopped or failed run that never recorded its workspace handback, and
 * whose every recorded process and tmux session is positively gone, is
 * released here by the exact handback `loop reconcile` writes, with the same
 * evidence. Anything short of that is not released and still conflicts.
 */
const releaseDeadTerminalRun = async (
  stored: StoredManifest,
  manifest: RunManifest,
  evidence: RunOwnershipEvidence,
  deps: LaunchReservationDeps
): Promise<ReleaseVerdict> => {
  if (
    evidence.workspaceReleasedAt.kind !== "absent" ||
    evidence.state.kind !== "valid"
  ) {
    return refused("it is not an unreleased terminal run");
  }
  const terminalState = evidence.state.value;
  const kind = reconcileKind(terminalState);
  if (!(kind && (terminalState === "stopped" || terminalState === "failed"))) {
    return refused(`it is ${terminalState}`);
  }
  const result = await reconcileLegacyStoppedRun(
    stored.manifestPath,
    manifest.runId,
    {
      groupCanStillOwnRun: (pgid, at) => groupCanStillOwnRun(pgid, at, deps),
      now: deps.now,
      pidCanStillOwnRun: (pid, at) => pidCanStillOwnRun(pid, at, deps),
      runtimeAbsent: (path) => tmuxRuntimeAbsentForManifest(path, deps),
      terminalState,
    }
  );
  if (result.status !== "changed") {
    return refused(
      result.status === "refused"
        ? `release refused: ${result.reason}`
        : "its release changed concurrently"
    );
  }
  deps.log(
    `[loop] released workspace of dead run ${manifest.runId} (${terminalState}, ${manifest.tmuxSession ?? "not-yet-bound"}): no recorded process is alive and its tmux session is gone; same handback as \`loop reconcile ${kind} ${manifest.runId}\``
  );
  return GRANTED;
};

const assertNoConflict = async (
  manifests: StoredManifest[],
  binding: LaunchWorkspaceBinding,
  excludedRunId: string | undefined,
  deps: LaunchReservationDeps
): Promise<void> => {
  let conflict: Error | undefined;
  for (const stored of manifests) {
    const { read, target } = stored;
    if (read.kind === "refuse") {
      if (read.runId !== undefined && read.runId === excludedRunId) {
        continue;
      }
      throw refusalError(read);
    }
    const { evidence, manifest } = read;
    if (manifest.runId === excludedRunId) {
      continue;
    }
    const verdict = await ownershipVerdict(
      manifest,
      target,
      deps,
      evidence,
      stored
    );
    if (verdict.granted) {
      continue;
    }
    if (
      manifest.workspaceBinding &&
      !workspaceConflict(manifest.workspaceBinding, binding)
    ) {
      continue;
    }
    const released = await releaseDeadTerminalRun(
      stored,
      manifest,
      evidence,
      deps
    );
    if (released.granted) {
      continue;
    }
    // Keep scanning: every dead run is released even when another run still
    // blocks, so the operator is left with only the runs that need a decision.
    conflict ??= conflictError(
      manifest,
      evidence.workspaceReleasedAt.kind === "absent" &&
        reconcileKind(manifest.state)
        ? released.reason
        : verdict.reason
    );
  }
  if (conflict) {
    throw conflict;
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

/**
 * Drops a recorded handback from the manifest a resume re-attaches to. Only
 * the marker changes; a manifest without one is not rewritten.
 */
const clearWorkspaceHandback = (manifestPath: string): void => {
  updateRunManifest(manifestPath, (current) =>
    current &&
    (current.workspaceReleasedAt !== undefined ||
      current.workspaceReleaseKind !== undefined)
      ? withoutWorkspaceHandback(current)
      : undefined
  );
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
  const tmux = requested.tmuxSession ? await deps.tmuxLiveness(target) : "dead";
  if (tmux === "unknown") {
    throw conflictError(requested);
  }
  opts.reservedRunId = requested.runId;
  opts.workspaceBinding = binding;
  if (requested.launchClaimId) {
    opts.launchClaimId = requested.launchClaimId;
  }
  if (tmux === "live") {
    clearWorkspaceHandback(storage.manifestPath);
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
  // Under the launch lock, after the conflict scan: the resumed run owns its
  // workspace again, so an earlier handback must not survive into its new
  // life (its helpers would be judged by it, and its next teardown would
  // report it as its own release).
  writeRunManifest(
    storage.manifestPath,
    touchRunManifest(
      withoutWorkspaceHandback({
        ...requested,
        launchAttemptId: attemptId,
        launchAttemptPid: deps.pid,
      }),
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
        driverEffort: opts.driverEffort,
        reviewerEffort: opts.reviewerEffort,
        seatModels: {
          claude: resolveLaunchModel("claude", opts, opts.agent !== "claude"),
          codex: resolveLaunchModel("codex", opts, opts.agent !== "codex"),
          ...(opts.ossModel
            ? { oss: resolveLaunchModel("oss", opts, opts.agent !== "oss") }
            : {}),
        },
        seatModelsDriver: opts.agent,
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
