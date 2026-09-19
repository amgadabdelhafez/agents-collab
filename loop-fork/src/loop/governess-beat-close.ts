// Close a finished run's governess-beat workflow.
//
// A run launched with LOOP_GOVERNESS_TEMPORAL_ADDRESS and
// LOOP_GOVERNESS_TEMPORAL_NAMESPACE journals into workflow
// `governess-beat:<runId>`. Nothing in the workflow ever returns, so without
// this module every stopped, failed or abandoned run leaves one execution
// RUNNING forever.
//
// CLOSE MECHANISM: terminate, not a completion signal. temporalWorkflow never
// returns (it is `Promise<never>`) and production runs no worker on the
// `loop-governess` task queue: the journal writes through signalWithStart
// precisely so no worker is needed. A completion signal would be buffered in
// history and never processed. A server-side terminate closes the execution
// without a worker and keeps its history, so the journal stays readable.
//
// SAFETY: the close refuses unless the run's own manifest proves the run is
// terminal, and refuses a workflow whose memo names a different repo (run ids
// are per-repo integers, so two repos can share one workflow id). The startup
// reconcile additionally skips any run whose tmux session is still alive and
// any workflow that carries no owner memo.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { governessBeatWorkflowId } from "./governess-beat-workflow";
import {
  GOVERNESS_BEAT_OWNER_MEMO_KEY,
  type GovernessTemporalConfig,
  governessTemporalConfigFromEnv,
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

export interface GovernessBeatDescription {
  ownerRepoId?: string;
  status: string;
}

/** The two server operations a close needs. */
export interface GovernessBeatWorkflowControl {
  close(): Promise<void>;
  /** undefined when no execution exists for the id. */
  describe(workflowId: string): Promise<GovernessBeatDescription | undefined>;
  terminate(workflowId: string, reason: string): Promise<void>;
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

/**
 * Close one run's beat workflow if, and only if, the run is provably over.
 *
 * `manifest` must be read immediately before the call. `requireOwnerMemo`
 * refuses a workflow with no owner memo; only the run's own governess, which
 * may have inherited a workflow an older binary created without the memo,
 * passes false.
 */
export const closeGovernessBeatWorkflow = async (input: {
  control: GovernessBeatWorkflowControl;
  manifest: RunManifest | undefined;
  reason: string;
  repoId: string;
  requireOwnerMemo: boolean;
  runId: string;
}): Promise<GovernessBeatCloseResult> => {
  const workflowId = governessBeatWorkflowId(input.runId);
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
  const described = await input.control.describe(workflowId);
  if (!described) {
    return { outcome: "absent", workflowId };
  }
  if (described.status !== "RUNNING") {
    return { detail: described.status, outcome: "already-closed", workflowId };
  }
  if (described.ownerRepoId && described.ownerRepoId !== input.repoId) {
    return {
      detail: `owned by ${described.ownerRepoId}`,
      outcome: "refused-foreign",
      workflowId,
    };
  }
  if (!described.ownerRepoId && input.requireOwnerMemo) {
    return {
      detail: "workflow carries no owner memo",
      outcome: "refused-unowned",
      workflowId,
    };
  }
  try {
    await input.control.terminate(
      workflowId,
      `loop run ${input.runId} is ${manifest.state}: ${input.reason}`
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
      const owner = description.memo?.[GOVERNESS_BEAT_OWNER_MEMO_KEY];
      return {
        ...(typeof owner === "string" ? { ownerRepoId: owner } : {}),
        status: description.status.name,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  },
  async terminate(workflowId, reason) {
    await (input.withDeadline ?? unbounded)(() =>
      input.client.getHandle(workflowId).terminate(reason)
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
 * terminal. A no-op, without loading the SDK, when the Temporal settings are
 * unset.
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
  const config = governessTemporalConfigFromEnv(input.env);
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
      workflowId: governessBeatWorkflowId(input.runId),
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
      requireOwnerMemo: true,
      runId: input.runId,
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
}): Promise<void> => {
  for (const candidate of input.candidates) {
    input.result.checked += 1;
    try {
      const closed = await closeGovernessBeatWorkflow({
        control: input.control,
        // Re-read: the run may have been resumed since the scan.
        manifest: readRunManifest(candidate.manifestPath),
        reason: "startup reconcile",
        repoId: input.repoId,
        requireOwnerMemo: true,
        runId: candidate.runId,
      });
      input.result.outcomes[closed.outcome] =
        (input.result.outcomes[closed.outcome] ?? 0) + 1;
      if (closed.outcome === "terminated") {
        input.log(
          `[loop] closed ${closed.workflowId} (run ${candidate.runId})`
        );
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
    return governessTemporalConfigFromEnv(env);
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
 * Temporal settings unset it reads nothing and dials nothing.
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
    await closeCandidates({ candidates, control, log, repoId, result });
  } finally {
    await control.close().catch(() => undefined);
  }
  return result;
};
