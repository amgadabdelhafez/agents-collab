import { describe, expect, test } from "bun:test";
import {
  projectSupervisorKnowledgeArtifacts,
  SupervisorKnowledgeArtifactReadModelError,
} from "../../src/loop/supervisor-knowledge-artifact-read-model";
import { SupervisorMessageReadModel } from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";

const ARTIFACT_A = `artifact://sha256/${"a".repeat(64)}`;
const ARTIFACT_B = `artifact://sha256/${"b".repeat(64)}`;
const WORKFLOW_A = `supervisor-message:${"1".repeat(64)}`;
const WORKFLOW_B = `supervisor-message:${"2".repeat(64)}`;

const messageProjection = (
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageProjection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [ARTIFACT_A],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: "2026-08-30T07:00:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:harvto",
  messageId: "message-artifact-a",
  nextRetryAt: null,
  phase: "routed",
  receivedAt: "2026-08-30T07:00:00.000Z",
  schema: "supervisor-message-status.v1",
  threadId: "thread-artifact-a",
  to: "supervisor:harness",
  ...overrides,
});

const boardFixture = () => {
  const board = new SupervisorMessageReadModel();
  board.upsert(
    WORKFLOW_A,
    messageProjection({ artifactRefs: [ARTIFACT_B, ARTIFACT_A] })
  );
  board.upsert(
    WORKFLOW_B,
    messageProjection({
      artifactRefs: [ARTIFACT_A],
      from: "supervisor:aicur",
      messageId: "message-artifact-b",
      receivedAt: "2026-08-30T07:01:00.000Z",
      threadId: "thread-artifact-b",
    })
  );
  return board.board();
};

describe("Supervisor knowledge artifact read model", () => {
  test("groups references with deterministic artifact and backlink ordering", () => {
    const result = projectSupervisorKnowledgeArtifacts(boardFixture());
    expect(result).toMatchObject({
      schema: "supervisor-knowledge-artifacts.v1",
      sourceRevision: 2,
    });
    expect(result.artifacts.map((artifact) => artifact.artifactRef)).toEqual([
      ARTIFACT_A,
      ARTIFACT_B,
    ]);
    expect(result.artifacts[0]).toMatchObject({
      referenceCount: 2,
      schema: "supervisor-knowledge-artifact.v1",
    });
    expect(
      result.artifacts[0]?.backlinks.map((backlink) => backlink.workflowId)
    ).toEqual([WORKFLOW_B, WORKFLOW_A]);
    expect(result.artifacts[1]?.backlinks).toHaveLength(1);
  });

  test("is byte-deterministic and output mutation cannot change its input", () => {
    const board = boardFixture();
    const before = JSON.stringify(board);
    const first = projectSupervisorKnowledgeArtifacts(board);
    const second = projectSupervisorKnowledgeArtifacts(board);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    first.artifacts[0]?.backlinks.push({
      actionRequired: "none",
      from: "supervisor:foreign",
      messageId: "foreign",
      phase: "acknowledged",
      receivedAt: "2026-08-30T07:02:00.000Z",
      threadId: "foreign",
      to: "supervisor:foreign",
      workflowId: `supervisor-message:${"f".repeat(64)}`,
    });
    expect(JSON.stringify(board)).toBe(before);
    expect(projectSupervisorKnowledgeArtifacts(board)).toEqual(second);
  });

  test("refuses extra fields, arbitrary paths, and contradictory lifecycle", () => {
    const board = boardFixture();
    expect(() =>
      projectSupervisorKnowledgeArtifacts({ ...board, body: "forbidden" })
    ).toThrow(SupervisorKnowledgeArtifactReadModelError);
    expect(() =>
      projectSupervisorKnowledgeArtifacts({
        ...board,
        items: [{ ...board.items[0], transcript: "forbidden" }],
      })
    ).toThrow("board item fields do not match the canonical schema");
    expect(() =>
      projectSupervisorKnowledgeArtifacts({
        ...board,
        items: [{ ...board.items[0], artifactRefs: ["/Users/private.txt"] }],
      })
    ).toThrow("artifactRefs are invalid");
    expect(() =>
      projectSupervisorKnowledgeArtifacts({
        ...board,
        items: [{ ...board.items[0], actionRequired: "none", phase: "routed" }],
      })
    ).toThrow("actionRequired conflicts with phase");
  });

  test("refuses duplicate reference and workflow identities", () => {
    const board = boardFixture();
    expect(() =>
      projectSupervisorKnowledgeArtifacts({
        ...board,
        items: [
          {
            ...board.items[0],
            artifactRefs: [ARTIFACT_A, ARTIFACT_A],
          },
        ],
      })
    ).toThrow("artifactRefs are invalid");
    expect(() =>
      projectSupervisorKnowledgeArtifacts({
        ...board,
        items: [board.items[0], board.items[0]],
      })
    ).toThrow("board workflow IDs must be unique");
  });
});
