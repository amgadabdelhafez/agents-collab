import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectSupervisorKnowledgeArtifacts,
  readSupervisorKnowledgeArtifacts,
  SupervisorKnowledgeArtifactReadModelError,
} from "../../src/loop/supervisor-knowledge-artifact-read-model";
import { SupervisorMessageReadModel } from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import {
  JsonlSupervisorThreadStore,
  SupervisorThreadStoreError,
} from "../../src/loop/supervisor-thread-store";

const ARTIFACT_A = `artifact://sha256/${"a".repeat(64)}`;
const ARTIFACT_B = `artifact://sha256/${"b".repeat(64)}`;
const WORKFLOW_A = `supervisor-message:${"1".repeat(64)}`;
const WORKFLOW_B = `supervisor-message:${"2".repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const journalPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-artifacts-"));
  roots.push(root);
  return join(root, "threads.jsonl");
};

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

const boardItem = (
  workflowId: string,
  overrides: Partial<SupervisorMessageProjection> = {}
) => {
  const board = new SupervisorMessageReadModel();
  board.upsert(workflowId, messageProjection(overrides));
  const item = board.board().items[0];
  if (!item) {
    throw new Error("board fixture did not produce an item");
  }
  return item;
};

describe("Supervisor knowledge artifact read model", () => {
  test("fresh-reads durable references with restart and lifecycle identity", () => {
    const journal = journalPath();
    const store = new JsonlSupervisorThreadStore(journal);
    store.append({
      item: boardItem(WORKFLOW_A, {
        artifactRefs: [ARTIFACT_B, ARTIFACT_A],
      }),
      messageKind: "question",
      observedAt: "2026-08-30T07:00:01.000Z",
      requestId: "append-knowledge-a",
    });
    store.append({
      item: boardItem(WORKFLOW_A, {
        actionRequired: "acknowledge",
        artifactRefs: [ARTIFACT_B, ARTIFACT_A],
        claimedAt: "2026-08-30T07:00:02.000Z",
        claimedBy: "supervisor:harness",
        phase: "claimed",
      }),
      messageKind: "question",
      observedAt: "2026-08-30T07:00:02.000Z",
      requestId: "append-knowledge-a-claimed",
    });
    store.append({
      item: boardItem(WORKFLOW_B, {
        from: "supervisor:aicur",
        messageId: "message-artifact-b",
        receivedAt: "2026-08-30T07:01:00.000Z",
        threadId: "thread-artifact-b",
      }),
      messageKind: "informational",
      observedAt: "2026-08-30T07:01:01.000Z",
      requestId: "append-knowledge-b",
    });

    const first = readSupervisorKnowledgeArtifacts(store);
    const restarted = readSupervisorKnowledgeArtifacts(
      new JsonlSupervisorThreadStore(journal)
    );
    expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
    expect(first).toMatchObject({
      schema: "supervisor-knowledge-artifacts.v2",
      sourceRevision: 3,
    });
    expect(first.artifacts.map((artifact) => artifact.artifactRef)).toEqual([
      ARTIFACT_A,
      ARTIFACT_B,
    ]);
    expect(first.artifacts[0]?.backlinks).toHaveLength(2);
    expect(
      first.artifacts[0]?.backlinks.find(
        (backlink) => backlink.workflowId === WORKFLOW_A
      )
    ).toMatchObject({
      actionRequired: "acknowledge",
      messageKind: "question",
      phase: "claimed",
    });
  });

  test("durable knowledge output is defensive and body/path free", () => {
    const store = new JsonlSupervisorThreadStore(journalPath());
    store.append({
      item: boardItem(WORKFLOW_A),
      messageKind: "authority-decision",
      observedAt: "2026-08-30T07:00:01.000Z",
      requestId: "append-defensive",
    });
    const first = readSupervisorKnowledgeArtifacts(store);
    const second = readSupervisorKnowledgeArtifacts(store);
    first.artifacts[0]?.backlinks.push({
      actionRequired: "none",
      from: "supervisor:foreign",
      messageId: "foreign",
      messageKind: "informational",
      phase: "acknowledged",
      receivedAt: "2026-08-30T07:02:00.000Z",
      threadId: "foreign",
      to: "supervisor:foreign",
      workflowId: `supervisor-message:${"f".repeat(64)}`,
    });
    expect(readSupervisorKnowledgeArtifacts(store)).toEqual(second);
    expect(JSON.stringify(second)).not.toContain("body");
    expect(JSON.stringify(second)).not.toContain("transcript");
    expect(JSON.stringify(second)).not.toContain("/Users/");
  });

  test("durable knowledge projection fails before corrupt journal input", () => {
    const journal = journalPath();
    writeFileSync(journal, "{not-json}\n", { encoding: "utf8", mode: 0o600 });
    expect(() =>
      readSupervisorKnowledgeArtifacts(new JsonlSupervisorThreadStore(journal))
    ).toThrow(SupervisorThreadStoreError);
  });

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
