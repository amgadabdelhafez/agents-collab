import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchBridgeMessage } from "../../src/loop/bridge-dispatch";
import {
  appendBridgeEvent,
  enqueueBridgeMessage,
  formatBridgeInbox,
  markBridgeDeadLetterReported,
  readBridgeEvents,
  readBridgeQueueHealth,
  readPendingBridgeMessages,
  readUnreportedBridgeDeadLetters,
} from "../../src/loop/bridge-store";
import {
  compactGovernessJournal,
  decideGovernessControlReconciliation,
  inspectGovernessJournalStorage,
  latestGovernessControlByKey,
  maintainGovernessJournal,
  prepareGovernessControl,
  readGovernessJournal,
  readPendingGovernessControlHistory,
  recordGovernessObservation,
  transitionGovernessControl,
} from "../../src/loop/governess-journal";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "governess-p0-"));

const observation = (
  journalFile: string,
  at: string,
  semanticPayload = "stable"
) =>
  recordGovernessObservation(journalFile, {
    agent: "codex",
    at,
    epoch: 7,
    heartbeatMs: 60_000,
    idempotencyKey: `7:runtime:${at}`,
    payload: JSON.stringify({ at, state: semanticPayload }),
    policyClass: "observe",
    semanticPayload,
    stream: "runtime-probe:codex",
  });

test("journal v2 coalesces stable observations and writes one-record heartbeats", () => {
  const root = tempDir();
  const journalFile = join(root, "control.jsonl");
  expect(observation(journalFile, "2026-07-25T10:00:00.000Z").written).toBe(
    true
  );
  expect(observation(journalFile, "2026-07-25T10:00:20.000Z").written).toBe(
    false
  );
  expect(observation(journalFile, "2026-07-25T10:01:00.000Z").written).toBe(
    true
  );
  expect(
    observation(journalFile, "2026-07-25T10:01:01.000Z", "changed").written
  ).toBe(true);

  const records = readGovernessJournal(journalFile);
  expect(records).toHaveLength(3);
  expect(records.every((record) => record.phase === "completed")).toBe(true);
  expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
  rmSync(root, { force: true, recursive: true });
});

test("journal index rebuild preserves the idempotency fence after dispatch", () => {
  const root = tempDir();
  const journalFile = join(root, "control.jsonl");
  const input = {
    action: "send-control" as const,
    agent: "codex" as const,
    at: "2026-07-25T10:00:00.000Z",
    epoch: 7,
    idempotencyKey: "7:send:codex:interrupt",
    payload: "continue",
    policyClass: "safe-automatic" as const,
  };
  const prepared = prepareGovernessControl(journalFile, input);
  transitionGovernessControl(
    journalFile,
    prepared.controlId,
    "dispatched",
    "2026-07-25T10:00:01.000Z"
  );

  appendFileSync(journalFile, "\n", "utf8");
  writeFileSync(`${journalFile}.index.json`, "{corrupt", "utf8");
  const recovered = prepareGovernessControl(journalFile, {
    ...input,
    at: "2026-07-25T10:00:02.000Z",
  });
  expect(recovered.controlId).toBe(prepared.controlId);
  expect(recovered.phase).toBe("dispatched");
  expect(readPendingGovernessControlHistory(journalFile)).toHaveLength(2);
  expect(inspectGovernessJournalStorage(journalFile)).toMatchObject({
    indexCurrent: true,
    pendingControls: 1,
  });
  rmSync(root, { force: true, recursive: true });
});

test("journal compaction archives superseded observations without losing controls", () => {
  const root = tempDir();
  const journalFile = join(root, "control.jsonl");
  observation(journalFile, "2026-07-25T10:00:00.000Z", "one");
  observation(journalFile, "2026-07-25T10:00:01.000Z", "two");
  observation(journalFile, "2026-07-25T10:00:02.000Z", "three");
  const control = prepareGovernessControl(journalFile, {
    action: "nudge",
    agent: "codex",
    at: "2026-07-25T10:00:03.000Z",
    epoch: 7,
    idempotencyKey: "7:nudge:codex:keep",
    payload: "status?",
    policyClass: "safe-automatic",
  });
  transitionGovernessControl(
    journalFile,
    control.controlId,
    "completed",
    "2026-07-25T10:00:04.000Z"
  );

  const result = compactGovernessJournal(
    journalFile,
    "2026-07-25T10:00:05.000Z"
  );
  expect(result).toMatchObject({ activeRecords: 3, archivedRecords: 2 });
  expect(result.archiveFile && existsSync(result.archiveFile)).toBe(true);
  expect(readFileSync(result.archiveFile as string, "utf8")).toContain(
    '"action":"observe-runtime"'
  );
  expect(readGovernessJournal(journalFile)).toHaveLength(3);
  expect(
    latestGovernessControlByKey(journalFile, "7:nudge:codex:keep")?.phase
  ).toBe("completed");
  rmSync(root, { force: true, recursive: true });
});

test("malformed crash tails fail closed without automatic repair", () => {
  const root = tempDir();
  const journalFile = join(root, "control.jsonl");
  observation(journalFile, "2026-07-25T10:00:00.000Z");
  appendFileSync(journalFile, '{"partial":', "utf8");
  expect(() => maintainGovernessJournal(journalFile)).toThrow("line 2");
  expect(readFileSync(journalFile, "utf8")).toEndWith('{"partial":');
  rmSync(root, { force: true, recursive: true });
});

test("duplicate hook evidence reconciles a dispatched control only once", () => {
  const root = tempDir();
  const journalFile = join(root, "control.jsonl");
  const control = prepareGovernessControl(journalFile, {
    action: "send-control",
    agent: "codex",
    at: "2026-07-25T10:00:00.000Z",
    epoch: 7,
    idempotencyKey: "7:send:codex:duplicate-hook",
    payload: "continue",
    policyClass: "safe-automatic",
  });
  transitionGovernessControl(
    journalFile,
    control.controlId,
    "dispatched",
    "2026-07-25T10:00:01.000Z"
  );
  const hook = {
    agent: "codex" as const,
    event: "UserPromptSubmit",
    eventId: "event-one",
    sequence: 4,
    ts: "2026-07-25T10:00:02.000Z",
  };
  const decisions = decideGovernessControlReconciliation(
    readGovernessJournal(journalFile),
    { codex: [hook, hook] }
  );
  expect(decisions).toHaveLength(1);
  rmSync(root, { force: true, recursive: true });
});

test("typed bridge metadata round-trips and urgent work is delivered first", () => {
  const root = tempDir();
  enqueueBridgeMessage(root, "claude", "codex", "low priority", {
    now: "2026-07-25T10:00:00.000Z",
    priority: "low",
  });
  enqueueBridgeMessage(root, "claude", "codex", "review now", {
    artifactRefs: ["src/loop/bridge-store.ts"],
    now: "2026-07-25T10:00:01.000Z",
    priority: "urgent",
    subject: "Review queue safety",
    taskId: "p0",
    threadId: "thread-7",
    type: "review_request",
  });
  const pending = readPendingBridgeMessages(
    root,
    Date.parse("2026-07-25T10:00:02.000Z")
  );
  expect(pending[0]).toMatchObject({
    artifactRefs: ["src/loop/bridge-store.ts"],
    message: "review now",
    priority: "urgent",
    subject: "Review queue safety",
    taskId: "p0",
    threadId: "thread-7",
    type: "review_request",
  });
  expect(formatBridgeInbox(pending)).toContain('"type": "review_request"');
  rmSync(root, { force: true, recursive: true });
});

test("bridge QoS deduplicates, supersedes, bounds, and dead-letters work", () => {
  const root = tempDir();
  const first = enqueueBridgeMessage(root, "claude", "codex", "review v1", {
    dedupeKey: "review:7",
    maxOutstanding: 1,
    now: "2026-07-25T10:00:00.000Z",
    type: "review_request",
  });
  const duplicate = enqueueBridgeMessage(
    root,
    "claude",
    "codex",
    "review duplicate",
    {
      dedupeKey: "review:7",
      maxOutstanding: 1,
      now: "2026-07-25T10:00:01.000Z",
    }
  );
  expect(duplicate).toMatchObject({
    entry: { id: first.entry.id },
    status: "duplicate",
  });
  const replacement = enqueueBridgeMessage(
    root,
    "claude",
    "codex",
    "review v2",
    {
      dedupeKey: "review:7",
      maxOutstanding: 1,
      now: "2026-07-25T10:00:02.000Z",
      supersede: true,
    }
  );
  expect(replacement.status).toBe("queued");
  expect(readPendingBridgeMessages(root)[0]?.message).toBe("review v2");
  const rejected = enqueueBridgeMessage(root, "codex", "codex", "overflow", {
    maxOutstanding: 1,
    now: "2026-07-25T10:00:03.000Z",
  });
  expect(rejected.status).toBe("dead-letter");
  expect(readBridgeQueueHealth(root)).toMatchObject({
    deadLetters: 1,
    pending: 1,
    superseded: 1,
  });
  rmSync(root, { force: true, recursive: true });
});

test("captured xchan dead letter is visible once only to its target", () => {
  const root = tempDir();
  const fixturePath = join(
    process.cwd(),
    "tests",
    "fixtures",
    "bridge-overflow",
    "xchan-dead-letter.redacted.jsonl"
  );
  const provenancePath = join(
    process.cwd(),
    "tests",
    "fixtures",
    "bridge-overflow",
    "provenance.json"
  );
  const fixture = readFileSync(fixturePath, "utf8");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
    fixtureSha256: string;
  };
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    provenance.fixtureSha256
  );
  writeFileSync(join(root, "bridge.jsonl"), fixture, "utf8");

  expect(readPendingBridgeMessages(root)).toEqual([]);
  expect(readUnreportedBridgeDeadLetters(root, "codex")).toEqual([]);
  const [deadLetter] = readUnreportedBridgeDeadLetters(root, "claude");
  expect(deadLetter).toMatchObject({
    entry: {
      id: "badac162-5e60-4b87-a182-d564e9b683df",
      message: "<redacted:internal-supervisor-message>",
      priority: "high",
      target: "claude",
    },
    reason: "target queue limit 32 reached",
  });
  expect(readBridgeQueueHealth(root).unreportedDeadLetters).toBe(1);

  markBridgeDeadLetterReported(root, deadLetter);
  expect(readUnreportedBridgeDeadLetters(root, "claude")).toEqual([]);
  expect(readBridgeQueueHealth(root).unreportedDeadLetters).toBe(0);
  expect(
    readBridgeEvents(root).filter((event) => event.kind === "reported")
  ).toHaveLength(1);
  rmSync(root, { force: true, recursive: true });
});

test("dead-letter reporting stays bounded and continues in later batches", () => {
  const root = tempDir();
  for (let index = 0; index < 101; index += 1) {
    expect(
      enqueueBridgeMessage(root, "codex", "claude", `overflow ${index}`, {
        maxOutstanding: 0,
        now: new Date(Date.UTC(2026, 6, 25, 10, 0, index)).toISOString(),
      }).status
    ).toBe("dead-letter");
  }

  expect(readPendingBridgeMessages(root)).toEqual([]);
  expect(readBridgeQueueHealth(root).unreportedDeadLetters).toBe(101);
  const firstBatch = readUnreportedBridgeDeadLetters(root, "claude");
  expect(firstBatch).toHaveLength(100);
  for (const deadLetter of firstBatch) {
    markBridgeDeadLetterReported(root, deadLetter);
  }
  const secondBatch = readUnreportedBridgeDeadLetters(root, "claude");
  expect(secondBatch).toHaveLength(1);
  markBridgeDeadLetterReported(root, secondBatch[0]);
  expect(readUnreportedBridgeDeadLetters(root, "claude")).toEqual([]);
  expect(readBridgeQueueHealth(root).unreportedDeadLetters).toBe(0);
  rmSync(root, { force: true, recursive: true });
});

test("a receipt before a dead letter cannot suppress later overflow", () => {
  const root = tempDir();
  appendBridgeEvent(root, {
    at: "2026-07-25T10:00:00.000Z",
    id: "out-of-order",
    kind: "message",
    message: "must remain visible",
    source: "codex",
    target: "claude",
  });
  appendBridgeEvent(root, {
    at: "2026-07-25T10:00:01.000Z",
    id: "out-of-order",
    kind: "reported",
    source: "codex",
    target: "claude",
  });
  appendBridgeEvent(root, {
    at: "2026-07-25T10:00:02.000Z",
    id: "out-of-order",
    kind: "dead-letter",
    reason: "target queue limit 32 reached",
    source: "codex",
    target: "claude",
  });

  expect(readUnreportedBridgeDeadLetters(root, "claude")).toHaveLength(1);
  rmSync(root, { force: true, recursive: true });
});

test("bridge TTL survives a backward clock and expires deterministically", async () => {
  const root = tempDir();
  const result = await dispatchBridgeMessage(
    root,
    "claude",
    "codex",
    "time bounded work",
    async () => false,
    () => false,
    {
      now: "2026-07-25T10:00:00.000Z",
      ttlMs: 1000,
      type: "work_request",
    }
  );
  expect(result.status).toBe("queued");
  expect(
    readPendingBridgeMessages(root, Date.parse("2026-07-25T09:00:00.000Z"))
  ).toHaveLength(1);
  expect(
    readPendingBridgeMessages(root, Date.parse("2026-07-25T10:00:01.000Z"))
  ).toHaveLength(0);
  expect(readBridgeEvents(root).at(-1)?.kind).toBe("expired");
  rmSync(root, { force: true, recursive: true });
});
