import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendBridgeEvent, type BridgeMessage } from "../../src/loop/bridge-store";
import {
  acknowledgeInteractionAction,
  agentInteractionId,
  answerInteractionAction,
  approveInteractionAction,
  type InteractionActionAuthorityInput,
  type InteractionActionIntakeRequest,
  processPendingInteractionActions,
  readInteractionActionIntake,
  rejectInteractionAction,
} from "../../src/loop/governess-interaction-intake";
import {
  ensureGovernessJournal,
  readGovernessJournal,
} from "../../src/loop/governess-journal";
import type { GovernessLifecycleEvent } from "../../src/loop/governess-runtime";
import {
  publishPublicAsk,
  readPublicAskRecords,
} from "../../src/loop/human-interaction-ask";
import type { Agent } from "../../src/loop/types";

const NOW = Date.parse("2026-08-28T05:30:00.000Z");
const EPISODE_AT = "2026-08-28T05:29:30.000Z";
const REPO_ID = "repo-1";
const RUN_ID = "7";
const EPOCH = 3;
const SEQUENCE = 12;
const FAKE_ETAG = `"${"a".repeat(64)}"`;
const FAKE_REVISION = "b".repeat(64);

interface RunFixture {
  readonly agent: Agent;
  readonly eventsFile: string;
  readonly journalFile: string;
  readonly lifecycleEvent: GovernessLifecycleEvent;
  readonly root: string;
  readonly runDir: string;
}

const makeRun = (agent: Agent = "claude"): RunFixture => {
  const root = mkdtempSync(join(tmpdir(), "interaction-intake-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      createdAt: "2026-08-28T05:00:00.000Z",
      cwd: "/redacted/worktree",
      mode: "paired",
      pid: 42,
      repoId: REPO_ID,
      runId: RUN_ID,
      state: "input-required",
      status: "running",
      updatedAt: EPISODE_AT,
    })
  );
  const lifecycleEvent: GovernessLifecycleEvent = {
    agent,
    at: EPISODE_AT,
    epoch: EPOCH,
    sequence: SEQUENCE,
    source: "agent-hook",
    sourceSequence: 41,
    state: "input-required",
  };
  writeFileSync(
    join(runDir, "governess-state.json"),
    JSON.stringify({ lifecycleEvents: { [agent]: lifecycleEvent } })
  );
  const journalFile = join(runDir, "governess-journal.jsonl");
  ensureGovernessJournal(journalFile);
  mkdirSync(join(runDir, "interaction-actions"), { recursive: true });
  return {
    agent,
    eventsFile: join(runDir, "interaction-actions", "events.jsonl"),
    journalFile,
    lifecycleEvent,
    root,
    runDir,
  };
};

const withRun = (
  run: (fixture: RunFixture) => void | Promise<void>,
  agent: Agent = "claude"
): Promise<void> => {
  const fixture = makeRun(agent);
  return Promise.resolve(run(fixture)).finally(() => {
    rmSync(fixture.root, { force: true, recursive: true });
  });
};

const events = (eventsFile: string) => {
  let text: string;
  try {
    text = readFileSync(eventsFile, "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

const writeRequested = (eventsFile: string, request: unknown): void => {
  const requestId = (request as { requestId: string }).requestId;
  const line = `${JSON.stringify({
    at: (request as { submittedAt: string }).submittedAt,
    eventId: `requested:${requestId}`,
    request,
    requestId,
    type: "requested",
    version: "1",
  })}\n`;
  writeFileSync(eventsFile, `${readExisting(eventsFile)}${line}`);
};

const readExisting = (eventsFile: string): string => {
  try {
    return readFileSync(eventsFile, "utf8");
  } catch {
    return "";
  }
};

const interactionId = (fixture: RunFixture): string =>
  agentInteractionId(
    { repoId: REPO_ID, runId: RUN_ID },
    fixture.agent,
    EPOCH,
    SEQUENCE,
    "input-required"
  );

const acknowledgeRequest = (
  fixture: RunFixture,
  overrides: Partial<InteractionActionIntakeRequest> = {}
): InteractionActionIntakeRequest => {
  const failedInteractionId = agentInteractionId(
    { repoId: REPO_ID, runId: RUN_ID },
    fixture.agent,
    EPOCH,
    SEQUENCE,
    "blocked"
  );
  const actionId = acknowledgeInteractionAction(failedInteractionId).id;
  const idempotencyKeyHash = "c".repeat(64);
  const base = {
    actionId,
    agent: fixture.agent,
    episode: {
      at: EPISODE_AT,
      epoch: EPOCH,
      sequence: SEQUENCE,
      state: "blocked" as const,
    },
    expectedEntityTag: FAKE_ETAG,
    expectedSourceRevision: FAKE_REVISION,
    idempotencyKeyHash,
    interactionId: failedInteractionId,
    payloadHash: "d".repeat(64),
    repoId: REPO_ID,
    runId: RUN_ID,
    submittedAt: "2026-08-28T05:30:00.000Z",
    version: "1" as const,
  };
  return {
    ...base,
    requestId: `iar_${require("node:crypto")
      .createHash("sha256")
      .update(`${base.interactionId}|${base.actionId}|${base.idempotencyKeyHash}`)
      .digest("hex")
      .slice(0, 32)}`,
    ...overrides,
  };
};

const decisionRequest = (
  fixture: RunFixture,
  askId: string,
  intent: "answer" | "approve" | "reject",
  value?: string
): InteractionActionIntakeRequest => {
  const crypto = require("node:crypto");
  const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
  const ixId = interactionId(fixture);
  const actionId =
    intent === "answer"
      ? answerInteractionAction(ixId).id
      : intent === "approve"
        ? approveInteractionAction(ixId).id
        : rejectInteractionAction(ixId).id;
  const idempotencyKeyHash = "e".repeat(64);
  const semanticAuditCorrelation =
    intent === "answer"
      ? `human-answer/v1:${askId}:${sha256(value as string)}`
      : `human-decision/v1:${askId}:${intent}`;
  const base = {
    actionId,
    agent: fixture.agent,
    askId,
    audience: "phone" as const,
    episode: {
      at: EPISODE_AT,
      epoch: EPOCH,
      sequence: SEQUENCE,
      state: "input-required" as const,
    },
    expectedAuthorityRevision: FAKE_REVISION,
    expectedEntityTag: FAKE_ETAG,
    expectedSourceRevision: FAKE_REVISION,
    idempotencyKeyHash,
    interactionId: ixId,
    intent,
    payloadHash: "f".repeat(64),
    repoId: REPO_ID,
    runId: RUN_ID,
    semanticAuditCorrelation,
    submittedAt: "2026-08-28T05:30:00.000Z",
    ...(value ? { value } : {}),
    version: "1" as const,
  };
  return {
    ...base,
    requestId: `iar_${sha256(
      `${base.interactionId}|${base.actionId}|${base.idempotencyKeyHash}`
    ).slice(0, 32)}`,
  };
};

const authority = (
  fixture: RunFixture,
  overrides: Partial<InteractionActionAuthorityInput> = {}
): InteractionActionAuthorityInput => ({
  agents: [fixture.agent],
  dispatch: () => Promise.resolve({ status: "delivered" as const }),
  driverLease: { epoch: EPOCH, expiresAt: "2026-08-28T06:00:00.000Z", holder: fixture.agent },
  epoch: EPOCH,
  fenceCurrent: () => true,
  journalFile: fixture.journalFile,
  lifecycleEvents: { [fixture.agent]: fixture.lifecycleEvent },
  now: () => NOW,
  repoId: REPO_ID,
  runDir: fixture.runDir,
  runId: RUN_ID,
  ...overrides,
});

/** Acknowledge requests anchor a "blocked"/"failed" episode, not the
 * fixture's default "input-required" one used for decision tests. */
const blockedAuthority = (
  fixture: RunFixture,
  overrides: Partial<InteractionActionAuthorityInput> = {}
): InteractionActionAuthorityInput =>
  authority(fixture, {
    lifecycleEvents: {
      [fixture.agent]: { ...fixture.lifecycleEvent, state: "blocked" },
    },
    ...overrides,
  });

const recordDecisionBridge = (
  fixture: RunFixture,
  controlId: string,
  askId: string,
  message: string
): void => {
  const entry: BridgeMessage = {
    at: new Date(NOW).toISOString(),
    dedupeKey: controlId,
    id: `bm_${controlId}`,
    kind: "message",
    message,
    priority: "normal",
    signature: "irrelevant-recomputed-on-read",
    source: "supervisor",
    subject: "human decision",
    target: fixture.agent,
    threadId: askId,
    type: "decision",
  };
  appendBridgeEvent(fixture.runDir, entry);
};

describe("interaction action acknowledgement", () => {
  test("a valid acknowledgement is dispatched and accepted", () =>
    withRun(async (fixture) => {
      const request = acknowledgeRequest(fixture);
      writeRequested(fixture.eventsFile, request);
      const dispatched: unknown[] = [];
      const processed = await processPendingInteractionActions(
        blockedAuthority(fixture, {
          dispatch: (input) => {
            dispatched.push(input);
            return Promise.resolve({ status: "delivered" });
          },
        })
      );
      expect(processed).toBe(1);
      expect(dispatched).toEqual([
        {
          agent: fixture.agent,
          controlId: expect.any(String),
          message: "Human acknowledged this interaction.",
        },
      ]);
      expect(
        readInteractionActionIntake(fixture.runDir).map((item) => item.state)
      ).toEqual(["accepted"]);
      const controls = readGovernessJournal(fixture.journalFile);
      expect(controls.at(-1)).toMatchObject({
        action: "send-control",
        phase: "accepted",
        policyClass: "safe-automatic",
      });
    }));

  test("an unfenced Governess denies the acknowledgement", () =>
    withRun(async (fixture) => {
      writeRequested(fixture.eventsFile, acknowledgeRequest(fixture));
      const processed = await processPendingInteractionActions(
        blockedAuthority(fixture, { fenceCurrent: () => false })
      );
      expect(processed).toBe(1);
      const snapshot = readInteractionActionIntake(fixture.runDir)[0];
      expect(snapshot?.state).toBe("denied");
      expect(snapshot?.reason).toBe("stale-governess-fence");
    }));

  test("a stale driver lease denies the acknowledgement", () =>
    withRun(async (fixture) => {
      writeRequested(fixture.eventsFile, acknowledgeRequest(fixture));
      const processed = await processPendingInteractionActions(
        blockedAuthority(fixture, {
          driverLease: {
            epoch: EPOCH,
            expiresAt: "2020-01-01T00:00:00.000Z",
            holder: fixture.agent,
          },
        })
      );
      expect(processed).toBe(1);
      const snapshot = readInteractionActionIntake(fixture.runDir)[0];
      expect(snapshot?.state).toBe("denied");
      expect(snapshot?.reason).toBe("driver-lease-unavailable");
    }));

  test("an episode that no longer matches this run's lifecycle state is denied", () =>
    withRun(async (fixture) => {
      writeRequested(fixture.eventsFile, acknowledgeRequest(fixture));
      const staleLifecycle: GovernessLifecycleEvent = {
        ...fixture.lifecycleEvent,
        sequence: fixture.lifecycleEvent.sequence + 1,
        state: "blocked",
      };
      const processed = await processPendingInteractionActions(
        blockedAuthority(fixture, {
          lifecycleEvents: { [fixture.agent]: staleLifecycle },
        })
      );
      expect(processed).toBe(1);
      const snapshot = readInteractionActionIntake(fixture.runDir)[0];
      expect(snapshot?.state).toBe("denied");
      expect(snapshot?.reason).toBe("interaction-episode-stale");
    }));

  test("a bridge dispatch that throws is recorded as failed, not silently dropped", () =>
    withRun(async (fixture) => {
      writeRequested(fixture.eventsFile, acknowledgeRequest(fixture));
      const processed = await processPendingInteractionActions(
        blockedAuthority(fixture, {
          dispatch: () => Promise.reject(new Error("bridge unavailable")),
        })
      );
      expect(processed).toBe(1);
      const snapshot = readInteractionActionIntake(fixture.runDir)[0];
      expect(snapshot?.state).toBe("failed");
      expect(snapshot?.reason).toBe("bridge-dispatch-ambiguous");
    }));

  test("processing the same acknowledgement twice does not redispatch", () =>
    withRun(async (fixture) => {
      writeRequested(fixture.eventsFile, acknowledgeRequest(fixture));
      let dispatches = 0;
      const auth = blockedAuthority(fixture, {
        dispatch: () => {
          dispatches += 1;
          return Promise.resolve({ status: "delivered" as const });
        },
      });
      expect(await processPendingInteractionActions(auth)).toBe(1);
      expect(await processPendingInteractionActions(auth)).toBe(0);
      expect(dispatches).toBe(1);
    }));
});

describe("interaction action human decisions", () => {
  test("delivers and resolves a short answer, requiring durable bridge evidence", () =>
    withRun(async (fixture) => {
      const ask = publishPublicAsk(fixture.runDir, fixture.agent, {
        kind: "question",
        prompt: "Which surface should be prioritized?",
        title: "Wearable next step",
      }, { now: () => new Date(NOW - 60_000).toISOString() });
      const answer = "Prioritize phone actions";
      const request = decisionRequest(fixture, ask.id, "answer", answer);
      writeRequested(fixture.eventsFile, request);
      const deliveries: unknown[] = [];
      const processed = await processPendingInteractionActions(
        authority(fixture, {
          dispatch: (input) => {
            deliveries.push(input);
            recordDecisionBridge(fixture, input.controlId, ask.id, answer);
            return Promise.resolve({ status: "delivered" });
          },
        })
      );
      expect(processed).toBe(1);
      expect(deliveries).toEqual([
        {
          agent: fixture.agent,
          controlId: expect.any(String),
          message: answer,
          subject: "human decision",
          threadId: ask.id,
          type: "decision",
        },
      ]);
      expect(
        readInteractionActionIntake(fixture.runDir).map((item) => item.state)
      ).toEqual(["accepted"]);
      expect(readPublicAskRecords(fixture.runDir)).toMatchObject([
        { id: ask.id, state: "resolved" },
      ]);
      const controls = readGovernessJournal(fixture.journalFile);
      expect(controls.at(-1)).toMatchObject({
        action: "deliver-human-decision",
        idempotencyKey: `human-answer/v1:${ask.id}:${require("node:crypto")
          .createHash("sha256")
          .update(answer)
          .digest("hex")}`,
        phase: "accepted",
        policyClass: "require-confirmation",
      });
    }));

  test("delivers and resolves an approval", () =>
    withRun(async (fixture) => {
      const ask = publishPublicAsk(fixture.runDir, fixture.agent, {
        consequence: "The migration may briefly pause background jobs.",
        kind: "approval",
        prompt: "Approve the verified database migration?",
        title: "Migration approval",
      }, { now: () => new Date(NOW - 60_000).toISOString() });
      const request = decisionRequest(fixture, ask.id, "approve");
      writeRequested(fixture.eventsFile, request);
      const processed = await processPendingInteractionActions(
        authority(fixture, {
          dispatch: (input) => {
            recordDecisionBridge(fixture, input.controlId, ask.id, "approve");
            return Promise.resolve({ status: "delivered" });
          },
        })
      );
      expect(processed).toBe(1);
      expect(
        readInteractionActionIntake(fixture.runDir)[0]?.state
      ).toBe("accepted");
      expect(readPublicAskRecords(fixture.runDir)[0]?.state).toBe("resolved");
    }));

  test("a delivery with no durable bridge evidence stays pending and is not resent", () =>
    withRun(async (fixture) => {
      const ask = publishPublicAsk(fixture.runDir, fixture.agent, {
        consequence: "Statement.",
        kind: "approval",
        prompt: "Approve?",
        title: "Title",
      }, { now: () => new Date(NOW - 60_000).toISOString() });
      writeRequested(
        fixture.eventsFile,
        decisionRequest(fixture, ask.id, "approve")
      );
      let dispatches = 0;
      const auth = authority(fixture, {
        dispatch: () => {
          dispatches += 1;
          return Promise.resolve({ status: "delivered" as const });
        },
      });
      expect(await processPendingInteractionActions(auth)).toBe(1);
      expect(await processPendingInteractionActions(auth)).toBe(1);
      expect(dispatches).toBe(1);
      expect(
        readInteractionActionIntake(fixture.runDir)[0]?.state
      ).toBe("pending");
      expect(readPublicAskRecords(fixture.runDir)[0]?.state).toBe("open");
      expect(readGovernessJournal(fixture.journalFile).at(-1)?.phase).toBe(
        "dispatched"
      );
    }));

  test("a rejected ask is denied when the ask has already been resolved differently", () =>
    withRun(async (fixture) => {
      const ask = publishPublicAsk(fixture.runDir, fixture.agent, {
        consequence: "Statement.",
        kind: "approval",
        prompt: "Approve?",
        title: "Title",
      }, { now: () => new Date(NOW - 60_000).toISOString() });
      writeRequested(
        fixture.eventsFile,
        decisionRequest(fixture, ask.id, "reject")
      );
      // Resolve the ask out from under the pending request (e.g. resolved by
      // another accepted decision first).
      const { resolvePublicAskDecision } = await import(
        "../../src/loop/human-interaction-ask"
      );
      resolvePublicAskDecision(fixture.runDir, {
        askId: ask.id,
        binding: {
          agent: fixture.agent,
          epoch: EPOCH,
          repoId: REPO_ID,
          runId: RUN_ID,
          sequence: SEQUENCE,
        },
        intent: "approve",
        resolvedAt: "2026-08-28T05:30:30.000Z",
      });
      const processed = await processPendingInteractionActions(
        authority(fixture)
      );
      expect(processed).toBe(1);
      const snapshot = readInteractionActionIntake(fixture.runDir)[0];
      expect(snapshot?.state).toBe("denied");
      expect(snapshot?.reason).toBe("decision-resolution-conflict");
    }));
});

describe("interaction action journal forward-compatibility", () => {
  test("a requested event with an unrecognized kind is left untouched", () =>
    withRun(async (fixture) => {
      writeFileSync(
        fixture.eventsFile,
        `${JSON.stringify({
          at: "2026-08-28T05:30:00.000Z",
          eventId: "requested:iar_ffffffffffffffffffffffffffffffff",
          request: { kind: "future-kind" },
          requestId: "iar_ffffffffffffffffffffffffffffffff",
          type: "requested",
          version: "1",
        })}\n`
      );
      expect(readInteractionActionIntake(fixture.runDir)).toEqual([]);
      const processed = await processPendingInteractionActions(
        authority(fixture)
      );
      expect(processed).toBe(0);
      expect(events(fixture.eventsFile)).toHaveLength(1);
    }));

  test("a lifecycle-teardown request is processed through the unified intake", () =>
    withRun(async (fixture) => {
      const crypto = require("node:crypto");
      const idempotencyKeyHash = "9".repeat(64);
      const requestId = `iar_${crypto
        .createHash("sha256")
        .update(`lifecycle-teardown|${REPO_ID}|${RUN_ID}|${idempotencyKeyHash}`)
        .digest("hex")
        .slice(0, 32)}`;
      writeRequested(fixture.eventsFile, {
        idempotencyKeyHash,
        kind: "lifecycle-teardown",
        reason: "operator ended the run from the phone",
        repoId: REPO_ID,
        requestId,
        runId: RUN_ID,
        submittedAt: "2026-08-28T05:30:00.000Z",
        version: "1",
      });
      const reasons: string[] = [];
      const processed = await processPendingInteractionActions(
        authority(fixture, { teardown: (reason) => reasons.push(reason) })
      );
      expect(processed).toBe(1);
      expect(reasons).toEqual(["operator ended the run from the phone"]);
      expect(
        readInteractionActionIntake(fixture.runDir)[0]?.state
      ).toBe("accepted");
    }));
});
