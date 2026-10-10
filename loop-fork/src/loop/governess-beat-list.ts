// Read-only inventory of governess-beat executions in one namespace (fix7).
//
// The operator's precondition check before re-enabling the Temporal journal,
// and the check after it: which beat executions exist, in which id format,
// on which task queue, owned by whom. It only lists (visibility) and never
// describes, signals, terminates or starts anything.

import type { WorkflowClient } from "@temporalio/client";
import {
  GOVERNESS_BEAT_MEMO,
  parseGovernessBeatWorkflowId,
} from "./governess-beat-identity";

const TASK_QUEUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,255}$/;
const BEAT_PREFIX = "governess-beat:";

export interface GovernessBeatListing {
  executionRunId: string;
  format: "legacy" | "unrecognised" | "v2";
  /**
   * legacy-owned: a pre-fix7 execution whose memo names a repo; only that
   * repo's close may terminate it. legacy-unowned: no memo; no code closes it,
   * the operator decides. v2: an owned-format execution. unrecognised: a
   * `governess-beat:` id neither format parses.
   */
  kind: "legacy-owned" | "legacy-unowned" | "unrecognised" | "v2";
  ownerRepoId?: string;
  runId?: string;
  startTime: string;
  status: string;
  taskQueue: string;
  workflowId: string;
}

/** The visibility query: every `temporalWorkflow`, optionally one queue. */
export const governessBeatListQuery = (input: {
  includeClosed?: boolean;
  taskQueue?: string;
}): string => {
  const clauses = ['WorkflowType = "temporalWorkflow"'];
  if (input.taskQueue !== undefined) {
    if (!TASK_QUEUE_RE.test(input.taskQueue)) {
      throw new Error(`task queue is invalid: ${input.taskQueue}`);
    }
    clauses.push(`TaskQueue = "${input.taskQueue}"`);
  }
  if (!input.includeClosed) {
    clauses.push('ExecutionStatus = "Running"');
  }
  return clauses.join(" AND ");
};

const listingOf = (info: {
  memo?: Record<string, unknown>;
  runId: string;
  startTime: Date;
  status: { name: string };
  taskQueue: string;
  workflowId: string;
}): GovernessBeatListing => {
  const owner = info.memo?.[GOVERNESS_BEAT_MEMO.repoId];
  const ownerRepoId = typeof owner === "string" ? owner : undefined;
  const parsed = parseGovernessBeatWorkflowId(info.workflowId);
  const base = {
    executionRunId: info.runId,
    ...(ownerRepoId ? { ownerRepoId } : {}),
    startTime: info.startTime.toISOString(),
    status: info.status.name,
    taskQueue: info.taskQueue,
    workflowId: info.workflowId,
  };
  if (!parsed) {
    return { ...base, format: "unrecognised", kind: "unrecognised" };
  }
  if (parsed.format === "v2") {
    return { ...base, format: "v2", kind: "v2", runId: parsed.owner.runId };
  }
  return {
    ...base,
    format: "legacy",
    kind: ownerRepoId ? "legacy-owned" : "legacy-unowned",
    runId: parsed.runId,
  };
};

/** Every `governess-beat:` execution the query matches, oldest first. */
export const listGovernessBeatExecutions = async (
  client: WorkflowClient,
  options: { includeClosed?: boolean; taskQueue?: string } = {}
): Promise<GovernessBeatListing[]> => {
  const listings: GovernessBeatListing[] = [];
  for await (const info of client.list({
    query: governessBeatListQuery(options),
  })) {
    if (info.workflowId.startsWith(BEAT_PREFIX)) {
      listings.push(listingOf(info));
    }
  }
  return listings.sort((left, right) =>
    left.startTime.localeCompare(right.startTime)
  );
};
