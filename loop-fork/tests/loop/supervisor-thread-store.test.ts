import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SupervisorMessageBoardItem,
  SupervisorMessageReadModel,
} from "../../src/loop/supervisor-message-read-model";
import type { SupervisorMessageProjection } from "../../src/loop/supervisor-message-workflow";
import {
  JsonlSupervisorThreadStore,
  type SupervisorThreadAppendRequest,
  SupervisorThreadStoreError,
} from "../../src/loop/supervisor-thread-store";

const ARTIFACT_A = `artifact://sha256/${"a".repeat(64)}`;
const ARTIFACT_B = `artifact://sha256/${"b".repeat(64)}`;
const WORKFLOW_A = `supervisor-message:${"1".repeat(64)}`;
const WORKFLOW_B = `supervisor-message:${"2".repeat(64)}`;
const WORKFLOW_C = `supervisor-message:${"3".repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "supervisor-thread-store-"));
  roots.push(value);
  return value;
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
  deliveredAt: "2026-08-30T07:20:00.000Z",
  deliveryAttempts: 1,
  escalatedAt: null,
  from: "supervisor:harvto",
  messageId: "message-thread-a",
  nextRetryAt: null,
  phase: "routed",
  receivedAt: "2026-08-30T07:20:00.000Z",
  schema: "supervisor-message-status.v1",
  threadId: "thread-a",
  to: "supervisor:harness",
  ...overrides,
});

const boardItem = (
  workflowId: string,
  overrides: Partial<SupervisorMessageProjection> = {}
): SupervisorMessageBoardItem => {
  const model = new SupervisorMessageReadModel();
  model.upsert(workflowId, projection(overrides));
  const item = model.board().items[0];
  if (!item) {
    throw new Error("board fixture did not produce an item");
  }
  return item;
};

const request = (
  item: SupervisorMessageBoardItem,
  overrides: Partial<SupervisorThreadAppendRequest> = {}
): SupervisorThreadAppendRequest => ({
  item,
  messageKind: "question",
  observedAt: "2026-08-30T07:20:01.000Z",
  requestId: `append-${item.workflowId.slice(-8)}`,
  ...overrides,
});

describe("durable supervisor thread store", () => {
  test("fsync-backed journal rebuilds deterministic threads after restart", () => {
    const storeRoot = root();
    const journal = join(storeRoot, "communication", "threads.jsonl");
    const store = new JsonlSupervisorThreadStore(journal);
    store.append(request(boardItem(WORKFLOW_A)));
    store.append(
      request(
        boardItem(WORKFLOW_B, {
          from: "supervisor:aicur",
          messageId: "message-thread-b",
          receivedAt: "2026-08-30T07:21:00.000Z",
        }),
        {
          messageKind: "informational",
          observedAt: "2026-08-30T07:21:01.000Z",
        }
      )
    );
    store.append(
      request(
        boardItem(WORKFLOW_C, {
          from: "supervisor:usage",
          messageId: "message-thread-c",
          receivedAt: "2026-08-30T07:22:00.000Z",
          threadId: "thread-b",
        }),
        {
          messageKind: "conflict",
          observedAt: "2026-08-30T07:22:01.000Z",
        }
      )
    );

    const first = store.read();
    const restarted = new JsonlSupervisorThreadStore(journal).read();
    expect(restarted).toEqual(first);
    expect(restarted.revision).toBe(3);
    expect(restarted.threads.map((thread) => thread.threadId)).toEqual([
      "thread-b",
      "thread-a",
    ]);
    expect(
      restarted.threads[1]?.messages.map((message) => message.item.workflowId)
    ).toEqual([WORKFLOW_A, WORKFLOW_B]);
    expect(restarted.threads[1]?.participants).toEqual([
      "supervisor:aicur",
      "supervisor:harness",
      "supervisor:harvto",
    ]);
    expect(readFileSync(journal, "utf8").endsWith("\n")).toBe(true);
    expect(statSync(journal).mode % 0o1000).toBe(0o600);
  });

  test("replays exact event IDs and persists lifecycle updates once", () => {
    const journal = join(root(), "threads.jsonl");
    const store = new JsonlSupervisorThreadStore(journal);
    const first = request(boardItem(WORKFLOW_A));
    expect(store.append(first)).toMatchObject({ replayed: false, revision: 1 });
    expect(store.append(first)).toMatchObject({ replayed: true, revision: 1 });
    const beforeCollision = readFileSync(journal, "utf8");
    expect(() =>
      store.append({ ...first, observedAt: "2026-08-30T07:20:02.000Z" })
    ).toThrow("conflicts with a durable event");
    expect(readFileSync(journal, "utf8")).toBe(beforeCollision);

    const claimed = boardItem(WORKFLOW_A, {
      actionRequired: "acknowledge",
      claimedAt: "2026-08-30T07:20:03.000Z",
      claimedBy: "supervisor:harness",
      phase: "claimed",
    });
    expect(
      store.append(
        request(claimed, {
          observedAt: "2026-08-30T07:20:03.000Z",
          requestId: "append-claimed-a",
        })
      )
    ).toMatchObject({ replayed: false, revision: 2 });
    expect(store.read().threads[0]?.messages[0]).toMatchObject({
      item: { actionRequired: "acknowledge", phase: "claimed" },
      messageKind: "question",
    });
  });

  test("refuses changes to immutable workflow and thread identity", () => {
    const journal = join(root(), "threads.jsonl");
    const store = new JsonlSupervisorThreadStore(journal);
    const item = boardItem(WORKFLOW_A);
    store.append(request(item));
    const original = readFileSync(journal, "utf8");
    const mutations: SupervisorThreadAppendRequest[] = [
      request(item, { messageKind: "failure", requestId: "change-kind" }),
      request(
        { ...item, threadId: "thread-foreign" },
        { requestId: "change-thread" }
      ),
      request(
        { ...item, artifactRefs: [ARTIFACT_B] },
        { requestId: "change-artifact" }
      ),
    ];
    for (const mutation of mutations) {
      expect(() => store.append(mutation)).toThrow(
        "changed immutable thread identity"
      );
      expect(readFileSync(journal, "utf8")).toBe(original);
    }
  });

  test("fails closed for malformed, truncated, duplicate, and extra-field rows", () => {
    const storeRoot = root();
    const journal = join(storeRoot, "threads.jsonl");
    const validRequest = request(boardItem(WORKFLOW_A));
    const validEvent = {
      ...validRequest,
      schema: "supervisor-thread-event.v1",
    };
    const cases = [
      "{not-json}\n",
      JSON.stringify(validEvent),
      `${JSON.stringify({ ...validEvent, body: "forbidden" })}\n`,
      `${JSON.stringify(validEvent)}\n${JSON.stringify(validEvent)}\n`,
      `${JSON.stringify({ ...validEvent, item: { ...validEvent.item, body: "forbidden" } })}\n`,
    ];
    for (const content of cases) {
      writeFileSync(journal, content, { encoding: "utf8", mode: 0o600 });
      expect(() => new JsonlSupervisorThreadStore(journal).read()).toThrow(
        SupervisorThreadStoreError
      );
    }
  });

  test("missing journal is empty and returned projections are defensive", () => {
    const journal = join(root(), "nested", "threads.jsonl");
    const store = new JsonlSupervisorThreadStore(journal);
    expect(store.read()).toEqual({
      revision: 0,
      schema: "supervisor-thread-board.v1",
      threads: [],
    });
    store.append(request(boardItem(WORKFLOW_A)));
    const first = store.read();
    first.threads[0]?.messages[0]?.item.artifactRefs.push(ARTIFACT_B);
    expect(store.read().threads[0]?.messages[0]?.item.artifactRefs).toEqual([
      ARTIFACT_A,
    ]);
    expect(JSON.stringify(store.read())).not.toContain("body");
    expect(JSON.stringify(store.read())).not.toContain("/Users/");
  });
});

const eventLine = (value: SupervisorThreadAppendRequest): string =>
  `${JSON.stringify({ ...value, schema: "supervisor-thread-event.v1" })}\n`;

describe("ra2: the journal is parsed once per change, not once per read", () => {
  test("repeated reads and the store's own appends never re-parse; another writer's append is parsed once", () => {
    const journal = join(root(), "threads.jsonl");
    const parses: number[] = [];
    const store = new JsonlSupervisorThreadStore(journal, {
      onParse: (bytes) => parses.push(bytes),
    });
    store.append(request(boardItem(WORKFLOW_A)));
    store.append(
      request(
        boardItem(WORKFLOW_A, {
          actionRequired: "acknowledge",
          claimedAt: "2026-08-30T07:20:03.000Z",
          claimedBy: "supervisor:harness",
          phase: "claimed",
        }),
        { observedAt: "2026-08-30T07:20:03.000Z", requestId: "claim-a" }
      )
    );
    for (let pass = 0; pass < 6; pass++) {
      expect(store.read().threads[0]?.messages[0]?.item.phase).toBe("claimed");
    }
    // The append replay check also uses the warm parse.
    expect(store.append(request(boardItem(WORKFLOW_A)))).toMatchObject({
      replayed: true,
      revision: 2,
    });
    expect(parses).toEqual([]);
    appendFileSync(
      journal,
      eventLine(request(boardItem(WORKFLOW_B), { requestId: "external-b" }))
    );
    expect(store.read().revision).toBe(3);
    expect(store.read().threads).toHaveLength(1);
    expect(parses).toEqual([statSync(journal).size]);
  });

  test("a writer that appends between the store's read and its own append is not lost", () => {
    const journal = join(root(), "threads.jsonl");
    writeFileSync(journal, eventLine(request(boardItem(WORKFLOW_A))), {
      mode: 0o600,
    });
    let raced = false;
    const store = new JsonlSupervisorThreadStore(journal, {
      onParse: () => {
        if (!raced) {
          raced = true;
          appendFileSync(
            journal,
            eventLine(
              request(boardItem(WORKFLOW_C), {
                observedAt: "2026-08-30T07:20:05.000Z",
                requestId: "racer-c",
              })
            )
          );
        }
      },
    });
    store.append(request(boardItem(WORKFLOW_B), { requestId: "append-b" }));
    const board = store.read();
    expect(board.revision).toBe(3);
    expect(
      board.threads
        .flatMap((thread) => thread.messages)
        .map((message) => message.item.workflowId)
        .sort()
    ).toEqual([WORKFLOW_A, WORKFLOW_B, WORKFLOW_C].sort());
  });

  test("a same-size rewrite is re-read, and a journal that becomes malformed fails closed", () => {
    const journal = join(root(), "threads.jsonl");
    const original = eventLine(request(boardItem(WORKFLOW_A)));
    writeFileSync(journal, original, { mode: 0o600 });
    const store = new JsonlSupervisorThreadStore(journal);
    expect(store.read().threads[0]?.messages[0]?.observedAt).toBe(
      "2026-08-30T07:20:01.000Z"
    );
    const rewritten = eventLine(
      request(boardItem(WORKFLOW_A), {
        observedAt: "2026-08-30T07:20:09.000Z",
      })
    );
    expect(rewritten.length).toBe(original.length);
    writeFileSync(journal, rewritten, { mode: 0o600 });
    expect(store.read().threads[0]?.messages[0]?.observedAt).toBe(
      "2026-08-30T07:20:09.000Z"
    );
    writeFileSync(journal, "{not-json}\n", { mode: 0o600 });
    expect(() => store.read()).toThrow(SupervisorThreadStoreError);
    expect(() => store.read()).toThrow(SupervisorThreadStoreError);
  });
});
