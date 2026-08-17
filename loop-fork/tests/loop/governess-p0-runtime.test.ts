import { expect, test } from "bun:test";
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
import {
  consumeBridgeInbox,
  dispatchBridgeMessage,
} from "../../src/loop/bridge-dispatch";
import {
  type BridgeTargetLiveness,
  enqueueBridgeMessage,
  formatBridgeInbox,
  markBridgeMessage,
  readBridgeEvents,
  readBridgeQueueHealth,
  readBridgeTargetLiveness,
  readPendingBridgeMessages,
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
import type { RunManifest } from "../../src/loop/run-state";

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
  const dead = (): BridgeTargetLiveness => "dead";
  const root = tempDir();
  const first = enqueueBridgeMessage(root, "claude", "codex", "review v1", {
    dedupeKey: "review:7",
    maxOutstanding: 1,
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: dead,
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
      targetLiveness: dead,
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
      targetLiveness: dead,
    }
  );
  expect(replacement.status).toBe("queued");
  expect(readPendingBridgeMessages(root, undefined, dead)[0]?.message).toBe(
    "review v2"
  );
  const rejected = enqueueBridgeMessage(root, "codex", "codex", "overflow", {
    maxOutstanding: 1,
    now: "2026-07-25T10:00:03.000Z",
    targetLiveness: dead,
  });
  expect(rejected.status).toBe("dead-letter");
  expect(readBridgeQueueHealth(root)).toMatchObject({
    deadLetters: 1,
    pending: 1,
    superseded: 1,
  });
  rmSync(root, { force: true, recursive: true });
});

test("bridge TTL survives a backward clock and expires deterministically", async () => {
  const dead = (): BridgeTargetLiveness => "dead";
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
      targetLiveness: dead,
      ttlMs: 1000,
      type: "work_request",
    }
  );
  expect(result.status).toBe("queued");
  expect(
    readPendingBridgeMessages(
      root,
      Date.parse("2026-07-25T09:00:00.000Z"),
      dead
    )
  ).toHaveLength(1);
  expect(
    readPendingBridgeMessages(
      root,
      Date.parse("2026-07-25T10:00:01.000Z"),
      dead
    )
  ).toHaveLength(0);
  expect(readBridgeEvents(root).at(-1)?.kind).toBe("expired");
  rmSync(root, { force: true, recursive: true });
});

test("D1 live liveness callback suppresses ttl expiry and queue-depth dead-letter terminalization", () => {
  const live = (): BridgeTargetLiveness => "live";
  const t0 = "2026-07-25T10:00:00.000Z";
  const t0Ms = Date.parse(t0);

  // (1) ttl path: enqueue with ttl, read after expiry while live.
  const ttlRoot = tempDir();
  enqueueBridgeMessage(ttlRoot, "claude", "codex", "ttl work", {
    now: t0,
    targetLiveness: live,
    ttlMs: 1000,
    type: "work_request",
  });
  const pendingAfterExpiry = readPendingBridgeMessages(
    ttlRoot,
    t0Ms + 2000,
    live
  );
  const ttlEvents = readBridgeEvents(ttlRoot);

  // (2) queue-depth path: one existing target message, then overflow while live.
  const depthRoot = tempDir();
  enqueueBridgeMessage(depthRoot, "claude", "codex", "first work", {
    maxOutstanding: 1,
    now: t0,
    type: "work_request",
  });
  const overflow = enqueueBridgeMessage(
    depthRoot,
    "claude",
    "codex",
    "overflow work",
    {
      maxOutstanding: 1,
      now: t0,
      targetLiveness: live,
      type: "work_request",
    }
  );
  const pendingAfterOverflow = readPendingBridgeMessages(depthRoot, t0Ms, live);
  const depthEvents = readBridgeEvents(depthRoot);

  expect(pendingAfterExpiry).toHaveLength(1);
  expect(pendingAfterExpiry[0]?.message).toBe("ttl work");
  expect(ttlEvents.every((event) => event.kind !== "expired")).toBe(true);
  expect(overflow.status).toBe("queued");
  expect(pendingAfterOverflow).toHaveLength(2);
  expect(pendingAfterOverflow.map((message) => message.message)).toEqual(
    expect.arrayContaining(["first work", "overflow work"])
  );
  expect(depthEvents.every((event) => event.kind !== "dead-letter")).toBe(true);

  rmSync(ttlRoot, { force: true, recursive: true });
  rmSync(depthRoot, { force: true, recursive: true });
});

test("D1 unknown liveness retains ttl-expired messages fail-closed", () => {
  const unknown = (): BridgeTargetLiveness => "unknown";
  const root = tempDir();
  enqueueBridgeMessage(root, "claude", "codex", "ttl unknown", {
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: unknown,
    ttlMs: 1000,
    type: "work_request",
  });

  const pending = readPendingBridgeMessages(
    root,
    Date.parse("2026-07-25T10:00:02.000Z"),
    unknown
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]?.message).toBe("ttl unknown");
  expect(pending[0]?.retainedReason).toBeUndefined();
  expect(
    readBridgeEvents(root).every((event) => event.kind !== "expired")
  ).toBe(true);
  rmSync(root, { force: true, recursive: true });
});

test("D1 live pressure slot reaches a pre-accept retained ceiling", () => {
  const live = (): BridgeTargetLiveness => "live";
  const root = tempDir();
  const options = {
    maxOutstanding: 1,
    maxRetained: 2,
    targetLiveness: live,
    type: "work_request" as const,
  };
  enqueueBridgeMessage(root, "claude", "codex", "base work", {
    ...options,
    now: "2026-07-25T10:00:00.000Z",
  });
  const retained = enqueueBridgeMessage(
    root,
    "claude",
    "codex",
    "retained work",
    { ...options, now: "2026-07-25T10:00:01.000Z" }
  );
  expect(retained).toMatchObject({
    entry: { retainedReason: "queue-pressure" },
    status: "queued",
  });
  const eventsBefore = readBridgeEvents(root);
  const transcriptBefore = readFileSync(join(root, "transcript.jsonl"), "utf8");

  const rejected = enqueueBridgeMessage(
    root,
    "claude",
    "codex",
    "rejected work",
    { ...options, now: "2026-07-25T10:00:02.000Z" }
  );
  expect(rejected.status).toBe("backpressure");
  expect(readBridgeEvents(root)).toEqual(eventsBefore);
  expect(readFileSync(join(root, "transcript.jsonl"), "utf8")).toBe(
    transcriptBefore
  );
  expect(transcriptBefore).not.toContain("rejected work");
  expect(readPendingBridgeMessages(root, undefined, live)).toHaveLength(2);
  rmSync(root, { force: true, recursive: true });
});

test("D1 later-dead evidence terminalizes retained ttl and pressure once", () => {
  let liveness: BridgeTargetLiveness = "live";
  const resolver = (): BridgeTargetLiveness => liveness;

  const ttlRoot = tempDir();
  const ttl = enqueueBridgeMessage(ttlRoot, "claude", "codex", "ttl retained", {
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: resolver,
    ttlMs: 1000,
    type: "work_request",
  });
  const afterTtl = Date.parse("2026-07-25T10:00:02.000Z");
  expect(readPendingBridgeMessages(ttlRoot, afterTtl, resolver)).toHaveLength(
    1
  );
  liveness = "dead";
  for (let index = 0; index < 3; index += 1) {
    expect(readPendingBridgeMessages(ttlRoot, afterTtl, resolver)).toHaveLength(
      0
    );
  }
  expect(
    readBridgeEvents(ttlRoot).filter(
      (event) => event.id === ttl.entry.id && event.kind === "expired"
    )
  ).toHaveLength(1);

  const pressureRoot = tempDir();
  liveness = "live";
  enqueueBridgeMessage(pressureRoot, "claude", "codex", "base work", {
    maxOutstanding: 1,
    maxRetained: 2,
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: resolver,
  });
  const pressure = enqueueBridgeMessage(
    pressureRoot,
    "claude",
    "codex",
    "pressure retained",
    {
      maxOutstanding: 1,
      maxRetained: 2,
      now: "2026-07-25T10:00:01.000Z",
      targetLiveness: resolver,
    }
  );
  expect(pressure.entry.retainedReason).toBe("queue-pressure");
  liveness = "dead";
  for (let index = 0; index < 3; index += 1) {
    expect(
      readPendingBridgeMessages(pressureRoot, afterTtl, resolver)
    ).toHaveLength(1);
  }
  expect(
    readBridgeEvents(pressureRoot).filter(
      (event) => event.id === pressure.entry.id && event.kind === "dead-letter"
    )
  ).toHaveLength(1);

  rmSync(ttlRoot, { force: true, recursive: true });
  rmSync(pressureRoot, { force: true, recursive: true });
});

test("D1 same-dedupe supersession remains accepted at retained ceiling", () => {
  const live = (): BridgeTargetLiveness => "live";
  const root = tempDir();
  const first = enqueueBridgeMessage(root, "claude", "codex", "review v1", {
    dedupeKey: "review:7",
    maxOutstanding: 1,
    maxRetained: 2,
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: live,
  });
  enqueueBridgeMessage(root, "claude", "codex", "pressure work", {
    maxOutstanding: 1,
    maxRetained: 2,
    now: "2026-07-25T10:00:01.000Z",
    targetLiveness: live,
  });

  const replacement = enqueueBridgeMessage(
    root,
    "claude",
    "codex",
    "review v2",
    {
      dedupeKey: "review:7",
      maxOutstanding: 1,
      maxRetained: 2,
      now: "2026-07-25T10:00:02.000Z",
      supersede: true,
      targetLiveness: live,
    }
  );
  expect(replacement.status).toBe("queued");
  expect(
    readBridgeEvents(root).filter(
      (event) => event.id === first.entry.id && event.kind === "superseded"
    )
  ).toHaveLength(1);
  expect(
    readPendingBridgeMessages(root, undefined, live).map(
      (message) => message.message
    )
  ).toEqual(expect.arrayContaining(["pressure work", "review v2"]));
  rmSync(root, { force: true, recursive: true });
});

test("D1 repeated recovery reads and consumes deliver one retained identity once", () => {
  const live = (): BridgeTargetLiveness => "live";
  const root = tempDir();
  const nowMs = Date.parse("2026-07-25T10:00:02.000Z");
  const queued = enqueueBridgeMessage(root, "claude", "codex", "exactly once", {
    now: "2026-07-25T10:00:00.000Z",
    targetLiveness: live,
    ttlMs: 1000,
    type: "work_request",
  });
  for (let index = 0; index < 3; index += 1) {
    expect(readPendingBridgeMessages(root, nowMs, live)).toHaveLength(1);
  }

  expect(consumeBridgeInbox(root, "codex", "consumed by recovery")).toEqual([
    expect.objectContaining({ id: queued.entry.id }),
  ]);
  expect(consumeBridgeInbox(root, "codex", "second recovery")).toHaveLength(0);
  expect(
    readBridgeEvents(root).filter(
      (event) => event.id === queued.entry.id && event.kind === "delivered"
    )
  ).toHaveLength(1);
  expect(readPendingBridgeMessages(root, nowMs, live)).toHaveLength(0);
  rmSync(root, { force: true, recursive: true });
});

test("D9 resolved acknowledgement emits once across supersession retry and replay", () => {
  const root = tempDir();
  try {
    const dedupeKeys = [
      "loop183-case1-clear-premise-conflict",
      "loop183-case1-clear-premise-conflict-followup",
      "loop183-case1-clear-premise-conflict-consolidated",
      "loop183-case1-consolidated-fallen-correction",
    ];
    const ackTimes = [
      "2026-08-12T03:48:14.778Z",
      "2026-08-12T03:48:15.026Z",
      "2026-08-12T03:48:15.274Z",
      "2026-08-12T03:48:15.528Z",
    ];
    const subject =
      "RESOLVED: Loop-183 identity/predicate semantics; no ruling required";
    const message = `RESOLVED from authoritative records; withdraw prior escalation under this key. No supervisor action required unless you disagree.

Final facts:
- Case 1 is d72e4fc...f189 per Loop-177 supersession; f8c... is diagnostic only.
- "Known-positive passes" means presence=true, not composite.
- T0 banked/fresh per-gate match is complete.
- Repair-2 expected clear: d72=false (0), fallen=true (180), B=false (0), C=false (0).
- Composite remains false for every case; fallen remains rejected on presence.
- Claude accepted T0 and recommended continue. Prereg exact-blob review is next; no repair score has run.`;

    const predecessors = dedupeKeys.map((dedupeKey, index) =>
      enqueueBridgeMessage(
        root,
        "codex",
        "supervisor",
        `Run197 predecessor ${index + 1}`,
        {
          dedupeKey,
          now: `2026-08-12T03:48:13.${index.toString().padStart(3, "0")}Z`,
          priority: "high",
          type: "escalation",
        }
      )
    );
    expect(readPendingBridgeMessages(root)).toHaveLength(4);

    const attempts = dedupeKeys.map((dedupeKey, index) =>
      enqueueBridgeMessage(root, "codex", "supervisor", message, {
        dedupeKey,
        now: ackTimes[index],
        priority: "high",
        subject,
        supersede: true,
        type: "ack",
      })
    );
    const beforeConsume = readBridgeEvents(root);
    const ackMessagesBeforeRetry = beforeConsume.filter(
      (event) => event.kind === "message" && event.type === "ack"
    );
    const superseded = beforeConsume.filter(
      (event) => event.kind === "superseded"
    );
    const transcriptBeforeRetry = readFileSync(
      join(root, "transcript.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { at: string; message: string })
      .filter((entry) => entry.message === message);
    const consumed = consumeBridgeInbox(
      root,
      "supervisor",
      "D9 resolved acknowledgement consumed"
    );
    const beforeRetry = readBridgeEvents(root);
    const deliveredBeforeRetry = beforeRetry.filter(
      (event) => event.kind === "delivered" && event.message === message
    );
    const postDeliveryRetry = enqueueBridgeMessage(
      root,
      "codex",
      "supervisor",
      message,
      {
        dedupeKey: dedupeKeys[3],
        now: "2026-08-12T03:48:16.000Z",
        priority: "high",
        subject,
        supersede: true,
        type: "ack",
      }
    );
    const finalEvents = readBridgeEvents(root);
    const finalAckMessages = finalEvents.filter(
      (event) => event.kind === "message" && event.type === "ack"
    );
    const finalTranscriptAcks = readFileSync(
      join(root, "transcript.jsonl"),
      "utf8"
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { at: string; message: string })
      .filter((entry) => entry.message === message);
    const pendingAckIds = readPendingBridgeMessages(root)
      .filter((entry) => entry.type === "ack")
      .map((entry) => entry.id);
    const canonicalId = attempts[0]?.entry.id;
    expect({
      ackIdsBeforeRetry: ackMessagesBeforeRetry.map((event) => event.id),
      attemptIds: attempts.map((attempt) => attempt.entry.id),
      attemptStatuses: attempts.map((attempt) => attempt.status),
      consumedIds: consumed.map((entry) => entry.id),
      deliveredIds: deliveredBeforeRetry.map((event) => event.id),
      finalAckIds: finalAckMessages.map((event) => event.id),
      finalTranscriptAckCount: finalTranscriptAcks.length,
      pendingAckIds,
      postDeliveryRetryId: postDeliveryRetry.entry.id,
      postDeliveryRetryStatus: postDeliveryRetry.status,
      supersededIds: superseded.map((event) => event.id),
      supersededReasons: superseded.map((event) => event.reason),
      transcriptAckCountBeforeRetry: transcriptBeforeRetry.length,
    }).toEqual({
      ackIdsBeforeRetry: [canonicalId],
      attemptIds: [canonicalId, canonicalId, canonicalId, canonicalId],
      attemptStatuses: ["queued", "duplicate", "duplicate", "duplicate"],
      consumedIds: [canonicalId],
      deliveredIds: [canonicalId],
      finalAckIds: [canonicalId],
      finalTranscriptAckCount: 1,
      pendingAckIds: [],
      postDeliveryRetryId: canonicalId,
      postDeliveryRetryStatus: "duplicate",
      supersededIds: predecessors.map((predecessor) => predecessor.entry.id),
      supersededReasons: predecessors.map(() => `superseded by ${canonicalId}`),
      transcriptAckCountBeforeRetry: 1,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("D9 acknowledgement identity preserves correlations and non-ack independence", () => {
  const root = tempDir();
  try {
    const identity = {
      artifactRefs: ["artifacts/one", "artifacts/two"],
      replyTo: "reply-one",
      subject: "resolved subject",
      taskId: "task-one",
      threadId: "thread-one",
      type: "ack" as const,
    };
    const canonical = enqueueBridgeMessage(
      root,
      "codex",
      "supervisor",
      "resolved body",
      {
        ...identity,
        dedupeKey: "predecessor-one",
        now: "2026-08-12T04:00:00.000Z",
        priority: "high",
      }
    );
    const metadataReplay = enqueueBridgeMessage(
      root,
      "codex",
      "supervisor",
      "resolved body",
      {
        ...identity,
        dedupeKey: "predecessor-two",
        expiresAt: "2026-08-12T05:00:00.000Z",
        now: "2026-08-12T04:00:01.000Z",
        priority: "low",
      }
    );
    expect(metadataReplay).toMatchObject({
      entry: { id: canonical.entry.id },
      status: "duplicate",
    });

    const distinct = [
      enqueueBridgeMessage(root, "claude", "supervisor", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:02.000Z",
      }),
      enqueueBridgeMessage(root, "codex", "codex", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:03.000Z",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "changed body", {
        ...identity,
        now: "2026-08-12T04:00:04.000Z",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:05.000Z",
        subject: "changed subject",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:06.000Z",
        replyTo: "reply-two",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:07.000Z",
        taskId: "task-two",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "resolved body", {
        ...identity,
        now: "2026-08-12T04:00:08.000Z",
        threadId: "thread-two",
      }),
      enqueueBridgeMessage(root, "codex", "supervisor", "resolved body", {
        ...identity,
        artifactRefs: ["artifacts/two", "artifacts/one"],
        now: "2026-08-12T04:00:09.000Z",
      }),
    ];
    expect(distinct.map((result) => result.status)).toEqual(
      Array.from({ length: distinct.length }, () => "queued")
    );
    expect(new Set(distinct.map((result) => result.entry.id)).size).toBe(
      distinct.length
    );

    const nonAckOne = enqueueBridgeMessage(
      root,
      "codex",
      "supervisor",
      "repeated ordinary body",
      { now: "2026-08-12T04:00:10.000Z", type: "message" }
    );
    const nonAckTwo = enqueueBridgeMessage(
      root,
      "codex",
      "supervisor",
      "repeated ordinary body",
      { now: "2026-08-12T04:00:11.000Z", type: "message" }
    );
    expect([nonAckOne.status, nonAckTwo.status]).toEqual(["queued", "queued"]);
    expect(nonAckOne.entry.id).not.toBe(nonAckTwo.entry.id);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("D9 acknowledgement replay avoids self-supersession and converges after pre-append crash", () => {
  const sameKeyRoot = tempDir();
  const crashRoot = tempDir();
  try {
    const canonical = enqueueBridgeMessage(
      sameKeyRoot,
      "codex",
      "supervisor",
      "resolved same key",
      {
        dedupeKey: "same-key",
        now: "2026-08-12T04:10:00.000Z",
        subject: "resolved",
        type: "ack",
      }
    );
    const sameKeyReplay = enqueueBridgeMessage(
      sameKeyRoot,
      "codex",
      "supervisor",
      "resolved same key",
      {
        dedupeKey: "same-key",
        now: "2026-08-12T04:10:01.000Z",
        subject: "resolved",
        supersede: true,
        type: "ack",
      }
    );
    expect(sameKeyReplay).toMatchObject({
      entry: { id: canonical.entry.id },
      status: "duplicate",
    });
    expect(
      readBridgeEvents(sameKeyRoot).filter(
        (event) => event.kind === "superseded"
      )
    ).toHaveLength(0);

    const predecessor = enqueueBridgeMessage(
      crashRoot,
      "codex",
      "supervisor",
      "pending predecessor",
      {
        dedupeKey: "crash-key",
        now: "2026-08-12T04:11:00.000Z",
        type: "escalation",
      }
    );
    markBridgeMessage(
      crashRoot,
      predecessor.entry,
      "superseded",
      "simulated crash before ack append"
    );
    const acceptedAfterCrash = enqueueBridgeMessage(
      crashRoot,
      "codex",
      "supervisor",
      "resolved after crash",
      {
        dedupeKey: "crash-key",
        now: "2026-08-12T04:11:01.000Z",
        subject: "resolved",
        supersede: true,
        type: "ack",
      }
    );
    const retryAfterAppend = enqueueBridgeMessage(
      crashRoot,
      "codex",
      "supervisor",
      "resolved after crash",
      {
        dedupeKey: "crash-key",
        now: "2026-08-12T04:11:02.000Z",
        subject: "resolved",
        supersede: true,
        type: "ack",
      }
    );
    expect(acceptedAfterCrash.status).toBe("queued");
    expect(retryAfterAppend).toMatchObject({
      entry: { id: acceptedAfterCrash.entry.id },
      status: "duplicate",
    });
    expect(
      readBridgeEvents(crashRoot).filter(
        (event) => event.kind === "message" && event.type === "ack"
      )
    ).toHaveLength(1);
    expect(
      readBridgeEvents(crashRoot).filter((event) => event.kind === "superseded")
    ).toHaveLength(1);
  } finally {
    rmSync(sameKeyRoot, { force: true, recursive: true });
    rmSync(crashRoot, { force: true, recursive: true });
  }
});

test("D9 explicit legacy and expired acknowledgements fence replay without promoting untyped rows", () => {
  const legacyRoot = tempDir();
  const untypedRoot = tempDir();
  const expiredRoot = tempDir();
  try {
    writeFileSync(
      join(legacyRoot, "bridge.jsonl"),
      `${[
        {
          at: "2026-08-12T04:20:00.000Z",
          id: "legacy-ack-earliest",
          kind: "message",
          message: "legacy resolved",
          source: "codex",
          target: "supervisor",
          type: "ack",
        },
        {
          at: "2026-08-12T04:20:01.000Z",
          id: "legacy-ack-earliest",
          kind: "delivered",
          source: "codex",
          target: "supervisor",
        },
        {
          at: "2026-08-12T04:20:02.000Z",
          id: "legacy-ack-later",
          kind: "message",
          message: "legacy resolved",
          source: "codex",
          target: "supervisor",
          type: "ack",
        },
        {
          at: "2026-08-12T04:20:03.000Z",
          id: "legacy-ack-later",
          kind: "delivered",
          source: "codex",
          target: "supervisor",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n{malformed\n`,
      "utf8"
    );
    const legacyReplay = enqueueBridgeMessage(
      legacyRoot,
      "codex",
      "supervisor",
      "legacy resolved",
      { now: "2026-08-12T04:20:04.000Z", type: "ack" }
    );
    expect(legacyReplay).toMatchObject({
      entry: { id: "legacy-ack-earliest" },
      status: "duplicate",
    });
    expect(existsSync(join(legacyRoot, "transcript.jsonl"))).toBe(false);

    writeFileSync(
      join(untypedRoot, "bridge.jsonl"),
      `${JSON.stringify({
        at: "2026-08-12T04:21:00.000Z",
        id: "legacy-untyped-message",
        kind: "message",
        message: "legacy resolved",
        source: "codex",
        target: "supervisor",
      })}\n`,
      "utf8"
    );
    const explicitAfterUntyped = enqueueBridgeMessage(
      untypedRoot,
      "codex",
      "supervisor",
      "legacy resolved",
      { now: "2026-08-12T04:21:01.000Z", type: "ack" }
    );
    expect(explicitAfterUntyped.status).toBe("queued");
    expect(
      readBridgeEvents(untypedRoot)
        .filter((event) => event.kind === "message")
        .map((event) => event.type)
    ).toEqual(["message", "ack"]);

    const expiring = enqueueBridgeMessage(
      expiredRoot,
      "codex",
      "supervisor",
      "expired resolved",
      {
        dedupeKey: "expiring-one",
        expiresAt: "2026-08-12T04:22:01.000Z",
        now: "2026-08-12T04:22:00.000Z",
        type: "ack",
      }
    );
    const expiredReplay = enqueueBridgeMessage(
      expiredRoot,
      "codex",
      "supervisor",
      "expired resolved",
      {
        dedupeKey: "expiring-two",
        now: "2026-08-12T04:22:02.000Z",
        priority: "urgent",
        targetLiveness: () => "dead",
        type: "ack",
      }
    );
    expect(expiredReplay).toMatchObject({
      entry: { id: expiring.entry.id },
      status: "duplicate",
    });
    expect(
      readBridgeEvents(expiredRoot).filter(
        (event) => event.id === expiring.entry.id && event.kind === "expired"
      )
    ).toHaveLength(1);
    expect(
      readBridgeEvents(expiredRoot).filter(
        (event) => event.kind === "message" && event.type === "ack"
      )
    ).toHaveLength(1);
  } finally {
    rmSync(legacyRoot, { force: true, recursive: true });
    rmSync(untypedRoot, { force: true, recursive: true });
    rmSync(expiredRoot, { force: true, recursive: true });
  }
});

test("D1 old and fixed message shapes reconstruct compatibly", () => {
  const unknown = (): BridgeTargetLiveness => "unknown";
  const root = tempDir();
  writeFileSync(
    join(root, "bridge.jsonl"),
    `${[
      {
        at: "2026-07-25T10:00:00.000Z",
        futureField: "ignored",
        id: "legacy-message",
        kind: "message",
        message: "legacy work",
        source: "claude",
        target: "codex",
      },
      {
        at: "2026-07-25T10:00:01.000Z",
        id: "fixed-message",
        kind: "message",
        message: "fixed pressure work",
        retainedReason: "queue-pressure",
        source: "claude",
        target: "codex",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
    "utf8"
  );

  const pending = readPendingBridgeMessages(
    root,
    Date.parse("2026-07-25T10:00:02.000Z"),
    unknown
  );
  expect(pending).toHaveLength(2);
  expect(
    pending.find((message) => message.id === "legacy-message")?.retainedReason
  ).toBeUndefined();
  expect(
    pending.find((message) => message.id === "fixed-message")?.retainedReason
  ).toBe("queue-pressure");
  expect(pending.some((message) => "futureField" in message)).toBe(false);
  rmSync(root, { force: true, recursive: true });
});

test("D1 target liveness combines exact configured evidence fail-closed", () => {
  const root = tempDir();
  const manifest = {
    codexAppServerPid: 77,
    codexRemoteUrl: "ws://127.0.0.1:4500",
    codexThreadId: "thread-7",
    tmuxPaneLeft: "%5",
    tmuxPaneLeftAgent: "codex",
    tmuxSession: "repo-loop-7",
  } as RunManifest;
  const resolve = (
    pane: BridgeTargetLiveness,
    appServer: BridgeTargetLiveness,
    value: RunManifest = manifest
  ): BridgeTargetLiveness =>
    readBridgeTargetLiveness(root, "codex", {
      paneLiveness: (session, targetPane) => {
        expect(session).toBe("repo-loop-7");
        expect(targetPane).toBe("%5");
        return pane;
      },
      processLiveness: (pid) => {
        expect(pid).toBe(77);
        return appServer;
      },
      readManifest: () => value,
    });

  expect(resolve("dead", "live")).toBe("live");
  expect(resolve("dead", "dead")).toBe("dead");
  expect(resolve("unknown", "dead")).toBe("unknown");
  expect(
    resolve("dead", "dead", {
      ...manifest,
      codexAppServerPid: undefined,
    })
  ).toBe("unknown");
  expect(
    readBridgeTargetLiveness(root, "claude", {
      paneLiveness: () => "dead",
      processLiveness: () => "dead",
      readManifest: () => manifest,
    })
  ).toBe("unknown");
  expect(readBridgeTargetLiveness(root, "supervisor")).toBe("unknown");
  rmSync(root, { force: true, recursive: true });
});
