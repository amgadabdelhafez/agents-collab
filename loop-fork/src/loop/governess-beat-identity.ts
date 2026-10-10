// Which governess-beat execution belongs to which run (fix7).
//
// THE DEFECT THIS REPLACES: the beat workflow id was `governess-beat:<runId>`
// (governessBeatWorkflowId). Run ids are per-repo integers, so two repos, or
// two hosts, journaling into one namespace derive the same id for their run
// 29. The journal wrote with signalWithStart, which signals whatever execution
// holds the id, and set the owner memo only when it created one; recovery read
// the id's history with no owner check. One repo's governess therefore wrote
// records into, and recovered records out of, another repo's journal.
//
// THE FIX: the id names the repo, the run and the deployment (the task queue,
// as the V2 deployment discriminator does), and every Temporal call verifies
// the execution's task queue and owner memo before it reads, signals or closes
// it. The legacy id is still recognised, but only to close an execution this
// owner provably created; nothing reads or writes it any more.
//
// This module is client side only. The workflow bundle does not import it, so
// the beat workflow's code, and the replay of every recorded history, is
// unchanged. In particular the beat's start result stays
// `governess-beat:<runId>` (governess-beat-workflow.ts `start`), which is a
// label inside the execution, not its id.

import { governessBeatWorkflowId } from "./governess-beat-workflow";

export const GOVERNESS_BEAT_ID_FORMAT = "v2";
const LEGACY_PREFIX = "governess-beat:";
const OWNED_PREFIX = `${LEGACY_PREFIX}${GOVERNESS_BEAT_ID_FORMAT}:`;

/**
 * Memo keys written when the journal creates a beat execution. `loopRepoId`
 * is the key the legacy journal already wrote, so a legacy execution's owner
 * is read the same way.
 */
export const GOVERNESS_BEAT_MEMO = {
  format: "loopBeatIdFormat",
  repoId: "loopRepoId",
  runId: "loopRunId",
  taskQueue: "loopTaskQueue",
} as const;

export interface GovernessBeatOwner {
  repoId: string;
  runId: string;
  taskQueue: string;
}

// A repo id is `<sanitized base>-<hash>` (run-state.ts buildRepoId) and a run
// id matches git.ts RUN_ID_RE: neither can hold a colon, so an owned id splits
// unambiguously and no legacy id (one colon) can look owned.
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
// The task queue rule of governessTemporalConfigFromEnv and the V2 port.
const TASK_QUEUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;

/** Validate an owner; every derivation and check below takes one. */
export const governessBeatOwner = (input: {
  repoId: string;
  runId: string;
  taskQueue: string;
}): GovernessBeatOwner => {
  if (!REPO_ID_RE.test(input.repoId)) {
    throw new Error(`governess beat repo id is invalid: ${input.repoId}`);
  }
  if (!RUN_ID_RE.test(input.runId)) {
    throw new Error(`governess beat run id is invalid: ${input.runId}`);
  }
  if (!TASK_QUEUE_RE.test(input.taskQueue)) {
    throw new Error(`governess beat task queue is invalid: ${input.taskQueue}`);
  }
  return {
    repoId: input.repoId,
    runId: input.runId,
    taskQueue: input.taskQueue,
  };
};

/** `governess-beat:v2:<repoId>:<runId>:<taskQueue>`. */
export const governessBeatOwnedWorkflowId = (
  owner: GovernessBeatOwner
): string => `${OWNED_PREFIX}${owner.repoId}:${owner.runId}:${owner.taskQueue}`;

/** The pre-fix7 id, `governess-beat:<runId>`: recognised, never written. */
export const governessBeatLegacyWorkflowId = (runId: string): string =>
  governessBeatWorkflowId(runId);

export type ParsedGovernessBeatWorkflowId =
  | { format: "legacy"; runId: string }
  | { format: "v2"; owner: GovernessBeatOwner };

export const parseGovernessBeatWorkflowId = (
  workflowId: string
): ParsedGovernessBeatWorkflowId | undefined => {
  if (workflowId.startsWith(OWNED_PREFIX)) {
    const [repoId = "", runId = "", ...queue] = workflowId
      .slice(OWNED_PREFIX.length)
      .split(":");
    try {
      return {
        format: "v2",
        owner: governessBeatOwner({
          repoId,
          runId,
          taskQueue: queue.join(":"),
        }),
      };
    } catch {
      return undefined;
    }
  }
  if (workflowId.startsWith(LEGACY_PREFIX)) {
    const runId = workflowId.slice(LEGACY_PREFIX.length);
    return RUN_ID_RE.test(runId) ? { format: "legacy", runId } : undefined;
  }
  return undefined;
};

export const governessBeatOwnerMemo = (
  owner: GovernessBeatOwner
): Record<string, string> => ({
  [GOVERNESS_BEAT_MEMO.format]: GOVERNESS_BEAT_ID_FORMAT,
  [GOVERNESS_BEAT_MEMO.repoId]: owner.repoId,
  [GOVERNESS_BEAT_MEMO.runId]: owner.runId,
  [GOVERNESS_BEAT_MEMO.taskQueue]: owner.taskQueue,
});

/** What a describe of one execution says about who owns it. */
export interface GovernessBeatExecution {
  /** The exact run that was described; calls must address this run. */
  executionRunId: string;
  memo: Record<string, unknown> | undefined;
  status: string;
  taskQueue: string;
  workflowId: string;
}

export type GovernessBeatOwnership =
  | { owned: true }
  | { detail: string; owned: false; reason: "foreign" | "unowned" };

const foreign = (detail: string): GovernessBeatOwnership => ({
  detail,
  owned: false,
  reason: "foreign",
});

/**
 * Is this execution the owner's? Owned only on the owner's task queue with a
 * memo naming the owner: for an owned-format id the whole memo, for a legacy
 * id the repo (all the legacy journal wrote). No memo is `unowned`, which no
 * caller treats as owned.
 */
export const governessBeatOwnership = (
  execution: GovernessBeatExecution,
  owner: GovernessBeatOwner,
  format: "legacy" | "v2"
): GovernessBeatOwnership => {
  if (execution.taskQueue !== owner.taskQueue) {
    return foreign(`runs on task queue ${execution.taskQueue}`);
  }
  const memo = execution.memo ?? {};
  const repoId = memo[GOVERNESS_BEAT_MEMO.repoId];
  if (typeof repoId !== "string") {
    return { detail: "carries no owner memo", owned: false, reason: "unowned" };
  }
  if (repoId !== owner.repoId) {
    return foreign(`owned by ${repoId}`);
  }
  if (format === "legacy") {
    return { owned: true };
  }
  const expected = governessBeatOwnerMemo(owner);
  for (const [key, value] of Object.entries(expected)) {
    if (memo[key] !== value) {
      return foreign(`memo ${key} is ${String(memo[key])}, not ${value}`);
    }
  }
  return { owned: true };
};
