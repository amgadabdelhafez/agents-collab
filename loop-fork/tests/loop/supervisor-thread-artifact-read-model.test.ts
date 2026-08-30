import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SupervisorMessageBoardItem,
  SupervisorMessageReadModel,
} from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import { readSupervisorThreadArtifacts } from "../../src/loop/supervisor-thread-artifact-read-model";
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
  const root = mkdtempSync(join(tmpdir(), "thread-artifacts-"));
  roots.push(root);
  return join(root, "threads.jsonl");
};

const projection = (
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageProjection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [ARTIFACT_A],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: "2026-08-30T07:40:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:harvto",
  messageId: "message-artifact-a",
  nextRetryAt: null,
  phase: "routed",
  receivedAt: "2026-08-30T07:40:00.000Z",
  schema: "supervisor-message-status.v1",
  threadId: "thread-artifact",
  to: "supervisor:harness",
  ...overrides,
});

const item = (
  workflowId: string,
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageBoardItem => {
  const model = new SupervisorMessageReadModel();
  model.upsert(workflowId, projection(overrides));
  const result = model.board().items[0];
  if (!result) {
    throw new Error("board fixture did not produce an item");
  }
  return result;
};

describe("durable supervisor thread artifact references", () => {
  test("survives restart with deterministic grouping and backlink ordering", () => {
    const journal = journalPath();
    const store = new JsonlSupervisorThreadStore(journal);
    store.append({
      item: item(WORKFLOW_A, { artifactRefs: [ARTIFACT_B, ARTIFACT_A] }),
      messageKind: "question",
      observedAt: "2026-08-30T07:40:01.000Z",
      requestId: "append-artifact-a",
    });
    store.append({
      item: item(WORKFLOW_B, {
        artifactRefs: [ARTIFACT_A],
        from: "supervisor:aicur",
        messageId: "message-artifact-b",
        receivedAt: "2026-08-30T07:41:00.000Z",
      }),
      messageKind: "conflict",
      observedAt: "2026-08-30T07:41:01.000Z",
      requestId: "append-artifact-b",
    });

    const first = readSupervisorThreadArtifacts(store);
    const restarted = readSupervisorThreadArtifacts(
      new JsonlSupervisorThreadStore(journal)
    );
    expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
    expect(first.artifacts.map((artifact) => artifact.artifactRef)).toEqual([
      ARTIFACT_A,
      ARTIFACT_B,
    ]);
    expect(first.artifacts[0]).toMatchObject({ referenceCount: 2 });
    expect(
      first.artifacts[0]?.backlinks.map((backlink) => [
        backlink.workflowId,
        backlink.messageKind,
      ])
    ).toEqual([
      [WORKFLOW_B, "conflict"],
      [WORKFLOW_A, "question"],
    ]);
  });

  test("lifecycle update replaces rather than duplicates a durable backlink", () => {
    const store = new JsonlSupervisorThreadStore(journalPath());
    store.append({
      item: item(WORKFLOW_A),
      messageKind: "question",
      observedAt: "2026-08-30T07:40:01.000Z",
      requestId: "append-routed",
    });
    store.append({
      item: item(WORKFLOW_A, {
        actionRequired: "acknowledge",
        claimedAt: "2026-08-30T07:42:00.000Z",
        claimedBy: "supervisor:harness",
        phase: "claimed",
      }),
      messageKind: "question",
      observedAt: "2026-08-30T07:42:00.000Z",
      requestId: "append-claimed",
    });
    const result = readSupervisorThreadArtifacts(store);
    expect(result.sourceRevision).toBe(2);
    expect(result.artifacts[0]).toMatchObject({ referenceCount: 1 });
    expect(result.artifacts[0]?.backlinks[0]).toMatchObject({
      actionRequired: "acknowledge",
      phase: "claimed",
    });
  });

  test("fresh reads are byte-identical and returned output is defensive", () => {
    const store = new JsonlSupervisorThreadStore(journalPath());
    store.append({
      item: item(WORKFLOW_A),
      messageKind: "authority-decision",
      observedAt: "2026-08-30T07:40:01.000Z",
      requestId: "append-authority",
    });
    const first = readSupervisorThreadArtifacts(store);
    const second = readSupervisorThreadArtifacts(store);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    first.artifacts[0]?.backlinks.push({
      actionRequired: "none",
      from: "supervisor:foreign",
      messageId: "foreign",
      messageKind: "informational",
      phase: "acknowledged",
      receivedAt: "2026-08-30T07:43:00.000Z",
      threadId: "foreign",
      to: "supervisor:foreign",
      workflowId: `supervisor-message:${"f".repeat(64)}`,
    });
    expect(readSupervisorThreadArtifacts(store)).toEqual(second);
    expect(JSON.stringify(second)).not.toContain("body");
    expect(JSON.stringify(second)).not.toContain("/Users/");
  });

  test("corrupt authoritative journal fails before artifact projection", () => {
    const journal = journalPath();
    writeFileSync(journal, "{not-json}\n", { encoding: "utf8", mode: 0o600 });
    expect(() =>
      readSupervisorThreadArtifacts(new JsonlSupervisorThreadStore(journal))
    ).toThrow(SupervisorThreadStoreError);
  });
});
