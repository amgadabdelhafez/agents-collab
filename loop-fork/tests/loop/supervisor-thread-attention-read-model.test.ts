import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SupervisorMessageBoardItem,
  SupervisorMessageReadModel,
} from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import { readSupervisorThreadAttention } from "../../src/loop/supervisor-thread-attention-read-model";
import {
  JsonlSupervisorThreadStore,
  type SupervisorThreadMessageKind,
  SupervisorThreadStoreError,
} from "../../src/loop/supervisor-thread-store";

const ARTIFACT = `artifact://sha256/${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const journalPath = (): string => {
  const root = mkdtempSync(join(tmpdir(), "thread-attention-"));
  roots.push(root);
  return join(root, "threads.jsonl");
};

const workflowId = (digit: string): string =>
  `supervisor-message:${digit.repeat(64)}`;

const projection = (
  suffix: string,
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageProjection => ({
  acknowledgedAt: null,
  actionRequired: "claim",
  artifactRefs: [ARTIFACT],
  claimedAt: null,
  claimedBy: null,
  deadLetteredAt: null,
  deliveredAt: "2026-08-30T06:00:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:harvto",
  messageId: `message-attention-${suffix}`,
  nextRetryAt: null,
  phase: "routed",
  receivedAt: `2026-08-30T06:0${suffix}:00.000Z`,
  schema: "supervisor-message-status.v1",
  threadId: "thread-attention",
  to: "supervisor:harness",
  ...overrides,
});

const item = (
  digit: string,
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageBoardItem => {
  const model = new SupervisorMessageReadModel();
  model.upsert(workflowId(digit), projection(digit, overrides));
  const result = model.board().items[0];
  if (!result) {
    throw new Error("board fixture did not produce an item");
  }
  return result;
};

const append = (
  store: JsonlSupervisorThreadStore,
  digit: string,
  messageKind: SupervisorThreadMessageKind,
  overrides: Partial<SupervisorMessageProjection> = {},
  requestSuffix = "initial"
): void => {
  store.append({
    item: item(digit, overrides),
    messageKind,
    observedAt: `2026-08-30T06:1${digit}:00.000Z`,
    requestId: `append-${digit}-${requestSuffix}`,
  });
};

describe("selective durable supervisor Attention", () => {
  test("includes exactly questions, conflicts, failures, and authority decisions", () => {
    const store = new JsonlSupervisorThreadStore(journalPath());
    append(store, "1", "question");
    append(store, "2", "conflict");
    append(store, "3", "failure");
    append(store, "4", "authority-decision", {
      acknowledgedAt: "2026-08-30T06:14:00.000Z",
      actionRequired: "none",
      claimedAt: "2026-08-30T06:13:00.000Z",
      claimedBy: "supervisor:harness",
      phase: "acknowledged",
    });
    append(store, "5", "informational");

    const attention = readSupervisorThreadAttention(store);
    expect(attention.items.map((entry) => entry.messageKind).sort()).toEqual([
      "authority-decision",
      "conflict",
      "failure",
      "question",
    ]);
    expect(
      attention.items.find(
        (entry) => entry.messageKind === "authority-decision"
      )
    ).toMatchObject({ actionRequired: "none", phase: "acknowledged" });
    expect(
      attention.items.some((entry) => entry.workflowId === workflowId("5"))
    ).toBe(false);
  });

  test("excludes informational messages across action states and replaces selected lifecycle", () => {
    const store = new JsonlSupervisorThreadStore(journalPath());
    append(store, "1", "informational");
    append(store, "2", "informational", {
      actionRequired: "acknowledge",
      claimedAt: "2026-08-30T06:12:00.000Z",
      claimedBy: "supervisor:harness",
      phase: "claimed",
    });
    append(store, "3", "informational", {
      deadLetteredAt: "2026-08-30T06:13:00.000Z",
      actionRequired: "dead-letter",
      phase: "dead-lettered",
    });
    append(store, "4", "failure");
    append(
      store,
      "4",
      "failure",
      {
        actionRequired: "acknowledge",
        claimedAt: "2026-08-30T06:14:00.000Z",
        claimedBy: "supervisor:harness",
        phase: "claimed",
      },
      "claimed"
    );

    const attention = readSupervisorThreadAttention(store);
    expect(attention.sourceRevision).toBe(5);
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({
      actionRequired: "acknowledge",
      messageKind: "failure",
      phase: "claimed",
    });
  });

  test("restart and repeated reads are ordered, byte-identical, and defensive", () => {
    const journal = journalPath();
    const store = new JsonlSupervisorThreadStore(journal);
    append(store, "1", "question");
    append(store, "2", "conflict", {
      receivedAt: "2026-08-30T06:01:00.000Z",
    });

    const first = readSupervisorThreadAttention(store);
    const repeated = readSupervisorThreadAttention(store);
    const restarted = readSupervisorThreadAttention(
      new JsonlSupervisorThreadStore(journal)
    );
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
    expect(JSON.stringify(restarted)).toBe(JSON.stringify(first));
    expect(first.items.map((entry) => entry.workflowId)).toEqual([
      workflowId("1"),
      workflowId("2"),
    ]);
    first.items[0]?.artifactRefs.push(`artifact://sha256/${"b".repeat(64)}`);
    expect(readSupervisorThreadAttention(store)).toEqual(repeated);
    expect(JSON.stringify(repeated)).not.toContain("body");
    expect(JSON.stringify(repeated)).not.toContain("/Users/");
  });

  test("corrupt authoritative journal fails before Attention projection", () => {
    const journal = journalPath();
    writeFileSync(journal, "{not-json}\n", { encoding: "utf8", mode: 0o600 });
    expect(() =>
      readSupervisorThreadAttention(new JsonlSupervisorThreadStore(journal))
    ).toThrow(SupervisorThreadStoreError);
  });
});
