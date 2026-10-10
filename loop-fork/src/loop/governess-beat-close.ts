// Close a finished run's governess-beat workflow.
//
// A run whose journal resolves to Temporal (the LOOP_GOVERNESS_TEMPORAL_*
// settings, or since fix8 the default derived from the orchestration config;
// see resolveGovernessTemporalConfig) journals into workflow
// `governess-beat:v2:<repoId>:<runId>:<taskQueue>` (governess-beat-identity.ts;
// before fix7, `governess-beat:<runId>`). Nothing in the workflow ever
// returns, so without this module every stopped, failed or abandoned run
// leaves one execution RUNNING forever.
//
// CLOSE MECHANISM: terminate, not a completion signal. temporalWorkflow never
// returns (it is `Promise<never>`) and production runs no worker on the
// `loop-governess` task queue: the journal writes through signalWithStart
// precisely so no worker is needed. A completion signal would be buffered in
// history and never processed. A server-side terminate closes the execution
// without a worker and keeps its history, so the journal stays readable.
//
// SAFETY: the close refuses unless the run's own manifest proves the run is
// terminal. Each execution it considers, the owned-format one and, during the
// transition, the legacy `governess-beat:<runId>` one, is closed only when it
// runs on this deployment's task queue and its memo names this repo (and, for
// the owned format, this run and queue); a foreign execution is
// `refused-foreign` and one without an owner memo `refused-unowned`, whoever
// asks. The terminate addresses the exact run that was verified. The startup
// reconcile additionally skips any run whose tmux session is still alive.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type GovernessBeatExecution,
  type GovernessBeatOwner,
  governessBeatLegacyWorkflowId,
  governessBeatOwnedWorkflowId,
  governessBeatOwner,
  governessBeatOwnership,
} from "./governess-beat-identity";
import {
  type GovernessTemporalConfig,
  governessTemporalConfigOrDefault,
} from "./governess-temporal-journal";
import { runProcessCleanupInternals } from "./run-process-cleanup";
import {
  buildManifestPath,
  isActiveRunState,
  type RunManifest,
  readRunManifest,
  resolveRepoId,
  resolveStorageRoot,
} from "./run-state";

const CONNECT_TIMEOUT_MS = 3000;
// Per describe/terminate call: connectTimeout only bounds the dial, so a server
// that accepts the connection and then hangs would otherwise stall CLI startup.
export const GOVERNESS_BEAT_RPC_TIMEOUT_MS = 5000;

type WithDeadline = <T>(call: () => Promise<T>) => Promise<T>;
const unbounded: WithDeadline = (call) => call();
const GRPC_NOT_FOUND = 5;

/** One described execution: its exact run, status, queue and memo. */
export type GovernessBeatDescription = Omit<
  GovernessBeatExecution,
  "workflowId"
>;

/** The two server operations a close needs. */
export interface GovernessBeatWorkflowControl {
  close(): Promise<void>;
  /** undefined when no execution exists for the id. */
  describe(workflowId: string): Promise<GovernessBeatDescription | undefined>;
  /** Terminates the exact run `executionRunId`, never whatever holds the id. */
  terminate(
    workflowId: string,
    executionRunId: string,
    reason: string
  ): Promise<void>;
}

export type GovernessBeatCloseOutcome =
  | "absent"
  | "already-closed"
  | "refused-foreign"
  | "refused-live"
  | "refused-unowned"
  | "terminated";

export interface GovernessBeatCloseResult {
  detail?: string;
  /**
   * The legacy `governess-beat:<runId>` execution, reported only when one
   * exists. Its own outcome: a foreign one is refused, never closed.
   */
  legacy?: Omit<GovernessBeatCloseResult, "legacy">;
  outcome: GovernessBeatCloseOutcome;
  workflowId: string;
}

const isNotFound = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; name?: unknown };
  return (
    candidate?.name === "WorkflowNotFoundError" ||
    candidate?.code === GRPC_NOT_FOUND
  );
};

type SingleCloseResult = Omit<GovernessBeatCloseResult, "legacy">;

/** Close one execution if, and only if, the owner provably holds it. */
const closeOwnedExecution = async (input: {
  control: GovernessBeatWorkflowControl;
  format: "legacy" | "v2";
  owner: GovernessBeatOwner;
  reason: string;
  workflowId: string;
}): Promise<SingleCloseResult> => {
  const { workflowId } = input;
  const described = await input.control.describe(workflowId);
  if (!described) {
    return { outcome: "absent", workflowId };
  }
  if (described.status !== "RUNNING") {
    return { detail: described.status, outcome: "already-closed", workflowId };
  }
  const ownership = governessBeatOwnership(
    { ...described, workflowId },
    input.owner,
    input.format
  );
  if (!ownership.owned) {
    return {
      detail: ownership.detail,
      outcome:
        ownership.reason === "unowned" ? "refused-unowned" : "refused-foreign",
      workflowId,
    };
  }
  try {
    await input.control.terminate(
      workflowId,
      described.executionRunId,
      input.reason
    );
  } catch (error) {
    // Closed or removed between describe and terminate: the goal holds.
    if (isNotFound(error)) {
      return {
        detail: "closed concurrently",
        outcome: "already-closed",
        workflowId,
      };
    }
    throw error;
  }
  return { outcome: "terminated", workflowId };
};

/**
 * Close one run's beat workflow, and its legacy-format predecessor, if, and
 * only if, the run is provably over and each execution is provably this
 * run's. `manifest` must be read immediately before the call; `taskQueue` is
 * this deployment's (the journal config's) task queue.
 */
export const closeGovernessBeatWorkflow = async (input: {
  control: GovernessBeatWorkflowControl;
  manifest: RunManifest | undefined;
  reason: string;
  repoId: string;
  runId: string;
  taskQueue: string;
}): Promise<GovernessBeatCloseResult> => {
  const owner = governessBeatOwner({
    repoId: input.repoId,
    runId: input.runId,
    taskQueue: input.taskQueue,
  });
  const workflowId = governessBeatOwnedWorkflowId(owner);
  const manifest = input.manifest;
  if (
    !manifest ||
    manifest.runId !== input.runId ||
    manifest.repoId !== input.repoId
  ) {
    return {
      detail: "run manifest is missing or names another run",
      outcome: "refused-live",
      workflowId,
    };
  }
  if (isActiveRunState(manifest.state)) {
    return {
      detail: `run is ${manifest.state}`,
      outcome: "refused-live",
      workflowId,
    };
  }
  const reason = `loop run ${input.runId} is ${manifest.state}: ${input.reason}`;
  const owned = await closeOwnedExecution({
    control: input.control,
    format: "v2",
    owner,
    reason,
    workflowId,
  });
  const legacy = await closeOwnedExecution({
    control: input.control,
    format: "legacy",
    owner,
    reason,
    workflowId: governessBeatLegacyWorkflowId(input.runId),
  });
  return legacy.outcome === "absent" ? owned : { ...owned, legacy };
};

/** A control over an already-connected WorkflowClient. */
export const createGovernessBeatWorkflowControl = (input: {
  client: import("@temporalio/client").WorkflowClient;
  close?: () => Promise<void>;
  // Bounds one RPC; the connected control passes the connection's deadline.
  withDeadline?: WithDeadline;
}): GovernessBeatWorkflowControl => ({
  async close() {
    await input.close?.();
  },
  async describe(workflowId) {
    try {
      const description = await (input.withDeadline ?? unbounded)(() =>
        input.client.getHandle(workflowId).describe()
      );
      return {
        executionRunId: description.runId,
        memo: description.memo,
        status: description.status.name,
        taskQueue: description.taskQueue,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  },
  async terminate(workflowId, executionRunId, reason) {
    await (input.withDeadline ?? unbounded)(() =>
      input.client.getHandle(workflowId, executionRunId).terminate(reason)
    );
  },
});

export const connectGovernessBeatWorkflowControl = async (
  config: GovernessTemporalConfig,
  rpcTimeoutMs = GOVERNESS_BEAT_RPC_TIMEOUT_MS
): Promise<GovernessBeatWorkflowControl> => {
  const { Connection, WorkflowClient } = await import("@temporalio/client");
  const connection = await Connection.connect({
    address: config.address,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  return createGovernessBeatWorkflowControl({
    client: new WorkflowClient({ connection, namespace: config.namespace }),
    close: () => connection.close(),
    withDeadline: (call) =>
      connection.withDeadline(Date.now() + rpcTimeoutMs, call),
  });
};

type ConnectControl = (
  config: GovernessTemporalConfig
) => Promise<GovernessBeatWorkflowControl>;

/**
 * Close the beat workflow of one run a launcher-side path has just made
 * terminal. A no-op, without loading the SDK, when the journal resolves off
 * (resolveGovernessTemporalConfig: opted out, or no orchestration config).
 */
export const closeGovernessBeatForTerminalRun = async (input: {
  connect?: ConnectControl;
  env: NodeJS.ProcessEnv;
  // The manifest the caller has just written, when it has it in hand.
  manifest?: RunManifest;
  manifestPath: string;
  reason: string;
  runId: string;
}): Promise<GovernessBeatCloseResult | undefined> => {
  const config = governessTemporalConfigOrDefault(input.env);
  if (!config) {
    return undefined;
  }
  const readManifest = (): RunManifest | undefined =>
    input.manifest ?? readRunManifest(input.manifestPath);
  const manifest = readManifest();
  if (!(manifest && !isActiveRunState(manifest.state))) {
    // Checked before dialling so a live run never costs a connection.
    return {
      detail: manifest ? `run is ${manifest.state}` : "run manifest is missing",
      outcome: "refused-live",
      workflowId: manifest
        ? governessBeatOwnedWorkflowId(
            governessBeatOwner({
              repoId: manifest.repoId,
              runId: input.runId,
              taskQueue: config.taskQueue,
            })
          )
        : governessBeatLegacyWorkflowId(input.runId),
    };
  }
  const control = await (input.connect ?? connectGovernessBeatWorkflowControl)(
    config
  );
  try {
    return await closeGovernessBeatWorkflow({
      control,
      manifest: readManifest(),
      reason: input.reason,
      repoId: manifest.repoId,
      runId: input.runId,
      taskQueue: config.taskQueue,
    });
  } finally {
    await control.close().catch(() => undefined);
  }
};

export interface GovernessBeatReconcileResult {
  checked: number;
  failed: number;
  outcomes: Partial<Record<GovernessBeatCloseOutcome, number>>;
  skippedLive: number;
}

const emptyReconcile = (): GovernessBeatReconcileResult => ({
  checked: 0,
  failed: 0,
  outcomes: {},
  skippedLive: 0,
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface ReconcileCandidate {
  manifestPath: string;
  runId: string;
}

const listRunIds = (repoRuns: string): string[] => {
  try {
    return readdirSync(repoRuns, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/**
 * Terminal runs of this repo whose tmux session is gone. Unknown tmux state
 * (`liveSessions` undefined) keeps every tmux-owned run, as abandoned-run GC
 * does.
 */
const collectReconcileCandidates = (input: {
  liveSessions: ReadonlySet<string> | undefined;
  repoId: string;
  repoRuns: string;
  result: GovernessBeatReconcileResult;
}): ReconcileCandidate[] => {
  const candidates: ReconcileCandidate[] = [];
  for (const runId of listRunIds(input.repoRuns)) {
    const manifestPath = buildManifestPath(join(input.repoRuns, runId));
    const manifest = readRunManifest(manifestPath);
    const ownTerminalRun =
      manifest?.runId === runId &&
      manifest.repoId === input.repoId &&
      !isActiveRunState(manifest.state);
    if (!(manifest && ownTerminalRun)) {
      continue;
    }
    const session = manifest.tmuxSession;
    if (session && (!input.liveSessions || input.liveSessions.has(session))) {
      input.result.skippedLive += 1;
      continue;
    }
    candidates.push({ manifestPath, runId });
  }
  return candidates;
};

const closeCandidates = async (input: {
  candidates: ReconcileCandidate[];
  control: GovernessBeatWorkflowControl;
  log: (line: string) => void;
  repoId: string;
  result: GovernessBeatReconcileResult;
  taskQueue: string;
}): Promise<void> => {
  const count = (outcome: GovernessBeatCloseOutcome): void => {
    input.result.outcomes[outcome] = (input.result.outcomes[outcome] ?? 0) + 1;
  };
  for (const candidate of input.candidates) {
    input.result.checked += 1;
    try {
      const closed = await closeGovernessBeatWorkflow({
        control: input.control,
        // Re-read: the run may have been resumed since the scan.
        manifest: readRunManifest(candidate.manifestPath),
        reason: "startup reconcile",
        repoId: input.repoId,
        runId: candidate.runId,
        taskQueue: input.taskQueue,
      });
      // The legacy execution counts too, so its refusals stay visible.
      for (const one of closed.legacy ? [closed, closed.legacy] : [closed]) {
        count(one.outcome);
        if (one.outcome === "terminated") {
          input.log(`[loop] closed ${one.workflowId} (run ${candidate.runId})`);
        }
      }
    } catch (error) {
      input.result.failed += 1;
      input.log(
        `[loop] governess-beat reconcile failed for run ${candidate.runId}: ${errorText(error)}`
      );
    }
  }
};

const reconcileConfig = (
  env: NodeJS.ProcessEnv,
  log: (line: string) => void
): GovernessTemporalConfig | undefined => {
  try {
    return governessTemporalConfigOrDefault(env);
  } catch (error) {
    log(`[loop] governess-beat reconcile skipped: ${errorText(error)}`);
    return undefined;
  }
};

/**
 * Startup reconcile: close the beat workflow of every run in this repo whose
 * manifest is terminal and whose tmux session is gone. Idempotent by
 * construction, because it reads the server's status each time and closing a
 * closed workflow is a no-op. Never throws; problems are logged. With the
 * journal resolved off it reads nothing and dials nothing.
 */
export const reconcileGovernessBeatWorkflows = async (
  options: {
    connect?: ConnectControl;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    listTmuxSessions?: () => ReadonlySet<string> | undefined;
    log?: (line: string) => void;
    repoId?: string;
    storageRoot?: string;
  } = {}
): Promise<GovernessBeatReconcileResult> => {
  const result = emptyReconcile();
  const env = options.env ?? process.env;
  const log = options.log ?? console.error;
  const config = reconcileConfig(env, log);
  if (!config) {
    return result;
  }
  const repoId = options.repoId ?? resolveRepoId(options.cwd ?? process.cwd());
  const storageRoot =
    options.storageRoot ?? resolveStorageRoot(options.home ?? env.HOME);
  const listTmuxSessions =
    options.listTmuxSessions ??
    runProcessCleanupInternals.deps.listTmuxSessions;
  const candidates = collectReconcileCandidates({
    liveSessions: listTmuxSessions(),
    repoId,
    repoRuns: join(storageRoot, repoId),
    result,
  });
  if (candidates.length === 0) {
    return result;
  }
  let control: GovernessBeatWorkflowControl;
  try {
    control = await (options.connect ?? connectGovernessBeatWorkflowControl)(
      config
    );
  } catch (error) {
    log(
      `[loop] governess-beat reconcile could not reach Temporal at ${config.address}: ${errorText(error)}`
    );
    result.failed = candidates.length;
    return result;
  }
  try {
    await closeCandidates({
      candidates,
      control,
      log,
      repoId,
      result,
      taskQueue: config.taskQueue,
    });
  } finally {
    await control.close().catch(() => undefined);
  }
  return result;
};
