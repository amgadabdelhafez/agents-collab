// Governess beat workflow identity (fix7). Each named check fails if the thing
// it names is absent:
//
//   unique     — the id names the repo, the run and the deployment (task
//                queue), so two repos, or two deployments, that share a
//                namespace and a run id get different workflow ids.
//   disjoint   — no owned id can equal a legacy `governess-beat:<runId>` id,
//                in either direction.
//   ownership  — an execution is this owner's only when it runs on the
//                owner's task queue and its memo names the owner; anything
//                else is foreign or unowned, never adopted.

import { describe, expect, test } from "bun:test";
import {
  GOVERNESS_BEAT_MEMO,
  type GovernessBeatExecution,
  governessBeatLegacyWorkflowId,
  governessBeatOwnedWorkflowId,
  governessBeatOwner,
  governessBeatOwnerMemo,
  governessBeatOwnership,
  parseGovernessBeatWorkflowId,
} from "../../src/loop/governess-beat-identity";

const OWNER = governessBeatOwner({
  repoId: "agents-collab-fa87e8608224",
  runId: "29",
  taskQueue: "loop-governess",
});

const execution = (
  overrides: Partial<GovernessBeatExecution> = {}
): GovernessBeatExecution => ({
  executionRunId: "run-1",
  memo: governessBeatOwnerMemo(OWNER),
  status: "RUNNING",
  taskQueue: OWNER.taskQueue,
  workflowId: governessBeatOwnedWorkflowId(OWNER),
  ...overrides,
});

describe("governess beat workflow id", () => {
  test("unique: the id names the repo, the run and the task queue", () => {
    expect(governessBeatOwnedWorkflowId(OWNER)).toBe(
      "governess-beat:v2:agents-collab-fa87e8608224:29:loop-governess"
    );
  });

  test("unique: two repos with the same run id on one namespace and queue get different ids", () => {
    const other = governessBeatOwner({
      ...OWNER,
      repoId: "harvto-0123456789ab",
    });
    expect(governessBeatOwnedWorkflowId(other)).not.toBe(
      governessBeatOwnedWorkflowId(OWNER)
    );
    // The legacy derivation collided for exactly this pair.
    expect(governessBeatLegacyWorkflowId(other.runId)).toBe(
      governessBeatLegacyWorkflowId(OWNER.runId)
    );
  });

  test("unique: one repo and run under two deployments (task queues) get different ids", () => {
    const elsewhere = governessBeatOwner({
      ...OWNER,
      taskQueue: "loop-governess-homelab",
    });
    expect(governessBeatOwnedWorkflowId(elsewhere)).not.toBe(
      governessBeatOwnedWorkflowId(OWNER)
    );
  });

  test("disjoint: an owned id parses back to its owner and never as legacy", () => {
    const owned = governessBeatOwnedWorkflowId({
      ...OWNER,
      taskQueue: "queue:with:colons",
    });
    expect(parseGovernessBeatWorkflowId(owned)).toEqual({
      format: "v2",
      owner: { ...OWNER, taskQueue: "queue:with:colons" },
    });
    expect(parseGovernessBeatWorkflowId("governess-beat:29")).toEqual({
      format: "legacy",
      runId: "29",
    });
    expect(parseGovernessBeatWorkflowId("supervisor-message:abc")).toBe(
      undefined
    );
    // A run id cannot hold a colon, so no legacy id looks owned.
    expect(() => governessBeatOwner({ ...OWNER, runId: "v2:x" })).toThrow(
      "run id"
    );
    expect(() => governessBeatOwner({ ...OWNER, repoId: "a:b" })).toThrow(
      "repo id"
    );
    expect(() => governessBeatOwner({ ...OWNER, taskQueue: "" })).toThrow(
      "task queue"
    );
  });

  test("the owner memo names the format, repo, run and task queue", () => {
    expect(governessBeatOwnerMemo(OWNER)).toEqual({
      [GOVERNESS_BEAT_MEMO.format]: "v2",
      [GOVERNESS_BEAT_MEMO.repoId]: OWNER.repoId,
      [GOVERNESS_BEAT_MEMO.runId]: OWNER.runId,
      [GOVERNESS_BEAT_MEMO.taskQueue]: OWNER.taskQueue,
    });
    // The legacy close path already reads this key; it must not move.
    expect(GOVERNESS_BEAT_MEMO.repoId).toBe("loopRepoId");
  });
});

describe("governess beat ownership", () => {
  test("ownership: the owner's own execution is owned", () => {
    expect(governessBeatOwnership(execution(), OWNER, "v2")).toEqual({
      owned: true,
    });
  });

  test("ownership: another task queue is foreign even with the owner's memo", () => {
    expect(
      governessBeatOwnership(
        execution({ taskQueue: "someone-elses-queue" }),
        OWNER,
        "v2"
      )
    ).toMatchObject({ owned: false, reason: "foreign" });
  });

  test("ownership: a memo naming another repo, run or queue is foreign", () => {
    for (const key of ["repoId", "runId", "taskQueue"] as const) {
      const memo = {
        ...governessBeatOwnerMemo(OWNER),
        [GOVERNESS_BEAT_MEMO[key]]: "someone-else",
      };
      expect(
        governessBeatOwnership(execution({ memo }), OWNER, "v2"),
        key
      ).toMatchObject({ owned: false, reason: "foreign" });
    }
    expect(
      governessBeatOwnership(
        execution({
          memo: {
            ...governessBeatOwnerMemo(OWNER),
            [GOVERNESS_BEAT_MEMO.format]: "v3",
          },
        }),
        OWNER,
        "v2"
      )
    ).toMatchObject({ owned: false, reason: "foreign" });
  });

  test("ownership: no memo is unowned, never owned", () => {
    expect(
      governessBeatOwnership(execution({ memo: undefined }), OWNER, "v2")
    ).toMatchObject({ owned: false, reason: "unowned" });
    expect(
      governessBeatOwnership(execution({ memo: {} }), OWNER, "legacy")
    ).toMatchObject({ owned: false, reason: "unowned" });
  });

  test("ownership: a legacy execution is owned on the owner's queue with the owner's repo memo", () => {
    const legacy = execution({
      memo: { [GOVERNESS_BEAT_MEMO.repoId]: OWNER.repoId },
      workflowId: governessBeatLegacyWorkflowId(OWNER.runId),
    });
    expect(governessBeatOwnership(legacy, OWNER, "legacy")).toEqual({
      owned: true,
    });
    expect(
      governessBeatOwnership(
        { ...legacy, memo: { [GOVERNESS_BEAT_MEMO.repoId]: "other-repo" } },
        OWNER,
        "legacy"
      )
    ).toMatchObject({ owned: false, reason: "foreign" });
    expect(
      governessBeatOwnership(
        { ...legacy, taskQueue: "another-queue" },
        OWNER,
        "legacy"
      )
    ).toMatchObject({ owned: false, reason: "foreign" });
  });
});
