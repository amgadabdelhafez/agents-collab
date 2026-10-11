import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMailboxCommand } from "../../src/loop/mailbox-command";
import { mailboxPathFor } from "../../src/loop/supervisor-mailbox-delivery";
import {
  type SupervisorMailboxV2AckBinding,
  SupervisorMailboxV2AcknowledgementReconciler,
  type SupervisorMailboxV2Lifecycle,
} from "../../src/loop/supervisor-mailbox-v2-acknowledgement";
import {
  deriveSupervisorMessageV2DeliveryId,
  deriveSupervisorMessageV2WorkflowId,
  type SupervisorMessageV2Projection,
} from "../../src/loop/supervisor-message-v2-contract";
import {
  runSupervisorMessageV2RecipientLifecycle,
  type SupervisorMessageV2RecipientLifecycleCommand,
  type SupervisorMessageV2RecipientLifecycleOutcome,
} from "../../src/loop/supervisor-message-v2-http";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ra2-mailbox-v2-")));
  roots.push(root);
  return root;
};

const BOB = "supervisor:bob";
const BOB_PRINCIPAL = "principal:bob";
const SENDER = { principal: "principal:sender", tenantId: "tenant:ra2" };
const V1 = `supervisor-message:${"1".repeat(64)}`;

const workflow = (dedupe: string) =>
  deriveSupervisorMessageV2WorkflowId(SENDER, dedupe, "ra2-test");
const deliveryKey = (workflowId: string, attempt = 1) =>
  deriveSupervisorMessageV2DeliveryId(SENDER, workflowId, attempt);

const envelope = (workflowId: string, key: string, target = BOB) => ({
  artifactRefs: [],
  at: "2026-10-11T00:00:00.000Z",
  body: `body of ${workflowId}`,
  delivery: "mailbox",
  idempotencyKey: key,
  messageId: `m-${key.slice(-8)}`,
  target,
  threadId: `t-${key.slice(-8)}`,
  workflowId,
});

const writeMailbox = (
  root: string,
  entries: ReturnType<typeof envelope>[]
): string => {
  const mailbox = mailboxPathFor(root, BOB);
  writeFileSync(
    mailbox,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
  return mailbox;
};

/** The recipient's own reader acknowledges exactly these keys. */
const readerAcks = (root: string, keys: string[]) =>
  runMailboxCommand([
    "mailbox",
    "ack",
    "--id",
    BOB,
    "--root",
    root,
    ...keys.flatMap((key) => ["--key", key]),
  ]);

const binding = (mailbox: string): SupervisorMailboxV2AckBinding => ({
  mailbox,
  principal: BOB_PRINCIPAL,
  supervisorId: BOB,
});

const receipt = (
  phase: string
): SupervisorMessageV2RecipientLifecycleOutcome => ({
  kind: "receipt",
  projection: { acknowledgedAt: null, claimedAt: null, phase } as Pick<
    SupervisorMessageV2Projection,
    "acknowledgedAt" | "claimedAt" | "phase"
  >,
});

interface Call {
  command: SupervisorMessageV2RecipientLifecycleCommand;
  identity: { principal: string; supervisorId: string };
}

const recording = (
  answer: (
    call: Call
  ) => SupervisorMessageV2RecipientLifecycleOutcome | Promise<never>
) => {
  const calls: Call[] = [];
  const lifecycle: SupervisorMailboxV2Lifecycle = (identity, command) => {
    const call = { command: { ...command }, identity: { ...identity } };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, lifecycle };
};

test("acknowledges only V2 envelopes the recipient's own cursor names, as that recipient, with loop a2a ack's request ids", async () => {
  const root = scratch();
  const read = workflow("read");
  const unread = workflow("unread");
  const foreign = workflow("foreign");
  const mailbox = writeMailbox(root, [
    envelope(V1, `${V1}:delivery:1`),
    envelope(read, deliveryKey(read)),
    envelope(unread, deliveryKey(unread)),
    envelope(foreign, deliveryKey(foreign), "supervisor:carol"),
  ]);
  readerAcks(root, [
    `${V1}:delivery:1`,
    deliveryKey(read),
    deliveryKey(foreign),
  ]);
  const { calls, lifecycle } = recording(({ command }) =>
    receipt(command.operation === "claim" ? "claimed" : "acknowledged")
  );
  const logs: string[] = [];
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle,
    log: (line) => logs.push(line),
  });
  const result = await reconciler.reconcile();
  expect(result).toMatchObject({
    acknowledged: 1,
    inspected: 1,
    misaddressed: 1,
    refused: 0,
  });
  // The unread V2 message, the V1 key and the misaddressed envelope: nothing.
  expect(calls).toEqual([
    {
      command: {
        deliveryKey: deliveryKey(read),
        operation: "claim",
        requestId: `a2a-ack:claim:${read}`,
        workflowId: read,
      },
      identity: { principal: BOB_PRINCIPAL, supervisorId: BOB },
    },
    {
      command: {
        deliveryKey: deliveryKey(read),
        operation: "acknowledge",
        requestId: `a2a-ack:acknowledge:${read}`,
        workflowId: read,
      },
      identity: { principal: BOB_PRINCIPAL, supervisorId: BOB },
    },
  ]);
  expect(logs.join("\n")).toContain("not completion");
  // Settled: a later pass sends nothing for it.
  await reconciler.reconcile();
  expect(calls).toHaveLength(2);
  // Once the reader acknowledges the other one, it is carried too.
  readerAcks(root, [deliveryKey(unread)]);
  const later = await reconciler.reconcile();
  expect(later.acknowledged).toBe(1);
  expect(calls.map((call) => call.command.workflowId)).toEqual([
    read,
    read,
    unread,
    unread,
  ]);
  expect(new Set(calls.map((call) => call.command.operation))).toEqual(
    new Set(["claim", "acknowledge"])
  );
});

test("an envelope with a malformed key or a non-V2 workflow id is never sent to the route", async () => {
  const root = scratch();
  const v2 = workflow("shape");
  const mailbox = writeMailbox(root, [
    envelope(v2, "peer:not-a-delivery-key"),
    envelope("peer-message:x", deliveryKey(v2, 2)),
  ]);
  readerAcks(root, ["peer:not-a-delivery-key", deliveryKey(v2, 2)]);
  const { calls, lifecycle } = recording(() => receipt("acknowledged"));
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle,
  });
  expect((await reconciler.reconcile()).inspected).toBe(0);
  expect(calls).toEqual([]);
});

test("early refusals wait for the server's retry time, transient failures back off and log once, and a decided refusal settles", async () => {
  const root = scratch();
  const early = workflow("early");
  const flaky = workflow("flaky");
  const decided = workflow("decided");
  const mailbox = writeMailbox(root, [
    envelope(early, deliveryKey(early)),
    envelope(flaky, deliveryKey(flaky)),
    envelope(decided, deliveryKey(decided)),
  ]);
  readerAcks(root, [
    deliveryKey(early),
    deliveryKey(flaky),
    deliveryKey(decided),
  ]);
  let now = Date.parse("2026-10-11T00:00:00.000Z");
  const deliveryRecordedAt = now + 10_000;
  let flakyUp = false;
  const { calls, lifecycle } = recording(({ command }) => {
    if (command.workflowId === early) {
      if (command.operation === "claim" && now < deliveryRecordedAt) {
        return {
          code: "delivery-not-recorded",
          kind: "refused",
          retryAt: new Date(deliveryRecordedAt).toISOString(),
        };
      }
      return receipt(
        command.operation === "claim" ? "claimed" : "acknowledged"
      );
    }
    if (command.workflowId === flaky) {
      if (!flakyUp) {
        return Promise.reject(new Error("engine unavailable"));
      }
      return receipt(
        command.operation === "claim" ? "claimed" : "acknowledged"
      );
    }
    // The workflow's own refusal, of both commands.
    return {
      code: "lifecycle-command-refused",
      kind: "refused",
      transient: false,
    };
  });
  const logs: string[] = [];
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle,
    log: (line) => logs.push(line),
    now: () => now,
  });
  const first = await reconciler.reconcile();
  expect(first).toMatchObject({ early: 1, failed: 1, refused: 1 });
  // A decided refusal reached the acknowledge (a refused claim does not stop
  // it, as on the HTTP client) and is not retried.
  expect(
    calls.filter((call) => call.command.workflowId === decided)
  ).toHaveLength(2);
  const count = (id: string) =>
    calls.filter((call) => call.command.workflowId === id).length;
  // Immediately again: nothing is due.
  const second = await reconciler.reconcile();
  expect(second.waiting).toBe(2);
  expect([count(early), count(flaky), count(decided)]).toEqual([1, 1, 2]);
  // Past the backoff (1s) but before the server's retryAt (10s).
  now += 1500;
  flakyUp = false;
  await reconciler.reconcile();
  expect([count(early), count(flaky), count(decided)]).toEqual([1, 2, 2]);
  expect(
    logs.filter((line) => line.includes(flaky) && line.includes("retrying"))
  ).toHaveLength(1);
  // Past retryAt and the doubled backoff: both converge.
  now += 10_000;
  flakyUp = true;
  const converged = await reconciler.reconcile();
  expect(converged.acknowledged).toBe(2);
  expect([count(early), count(flaky), count(decided)]).toEqual([3, 4, 2]);
  now += 600_000;
  await reconciler.reconcile();
  expect(calls).toHaveLength(9);
});

test("assignment-denied is retried with backoff, never settled", async () => {
  const root = scratch();
  const id = workflow("denied");
  const mailbox = writeMailbox(root, [envelope(id, deliveryKey(id))]);
  readerAcks(root, [deliveryKey(id)]);
  let now = 0;
  const { calls, lifecycle } = recording(() => ({
    code: "assignment-denied",
    kind: "refused",
  }));
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle,
    now: () => now,
  });
  expect((await reconciler.reconcile()).failed).toBe(1);
  // The claim's denial stops the pass: no acknowledge is sent after it.
  expect(calls.map((call) => call.command.operation)).toEqual(["claim"]);
  now += 1000;
  await reconciler.reconcile();
  expect(calls).toHaveLength(2);
});

test("a per-pass budget bounds route commands; the rest wait for the next pass", async () => {
  const root = scratch();
  const ids = ["a", "b", "c"].map(workflow);
  const mailbox = writeMailbox(
    root,
    ids.map((id) => envelope(id, deliveryKey(id)))
  );
  readerAcks(
    root,
    ids.map((id) => deliveryKey(id))
  );
  const { calls, lifecycle } = recording(({ command }) =>
    receipt(command.operation === "claim" ? "claimed" : "acknowledged")
  );
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle,
    maxMessagesPerPass: 2,
  });
  const first = await reconciler.reconcile();
  expect(first).toMatchObject({ acknowledged: 2, waiting: 1 });
  expect((await reconciler.reconcile()).acknowledged).toBe(1);
  expect(calls).toHaveLength(6);
});

test("an unreadable or absent mailbox is counted, never thrown", async () => {
  const root = scratch();
  const { calls, lifecycle } = recording(() => receipt("acknowledged"));
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [
      binding(join(root, "absent.jsonl")),
      // A directory where a file should be.
      binding(root),
    ],
    lifecycle,
  });
  const result = await reconciler.reconcile();
  expect(result.unreadable).toBe(1);
  expect(calls).toEqual([]);
});

test("end to end through the route's own lifecycle: the reader's cursor becomes the recipient's ACK, and a key the workflow never issued does not", async () => {
  const root = scratch();
  const real = workflow("real");
  const forged = workflow("forged");
  const other = { principal: "principal:other", tenantId: "tenant:ra2" };
  const mailbox = writeMailbox(root, [
    envelope(real, deliveryKey(real, 2)),
    // A delivery id of the same workflow under another scope: shaped right,
    // never issued for this message.
    envelope(forged, deriveSupervisorMessageV2DeliveryId(other, forged, 1)),
  ]);
  readerAcks(root, [
    deliveryKey(real, 2),
    deriveSupervisorMessageV2DeliveryId(other, forged, 1),
  ]);
  const governed: unknown[] = [];
  const state = new Map<string, string>();
  const governance = {
    acknowledge: (command: {
      claimant: string;
      requestId: string;
      workflowId: string;
    }) => {
      governed.push({ operation: "acknowledge", ...command });
      state.set(command.workflowId, "acknowledged");
      return Promise.resolve({
        acknowledgedAt: "2026-10-11T00:00:01.000Z",
        claimedAt: "2026-10-11T00:00:00.500Z",
        phase: "acknowledged",
      } as SupervisorMessageV2Projection);
    },
    claim: (command: {
      claimant: string;
      requestId: string;
      workflowId: string;
    }) => {
      governed.push({ operation: "claim", ...command });
      state.set(command.workflowId, "claimed");
      return Promise.resolve({
        acknowledgedAt: null,
        claimedAt: "2026-10-11T00:00:00.500Z",
        phase: "claimed",
      } as SupervisorMessageV2Projection);
    },
  };
  const reconciler = new SupervisorMailboxV2AcknowledgementReconciler({
    bindings: [binding(mailbox)],
    lifecycle: (identity, command) =>
      runSupervisorMessageV2RecipientLifecycle(
        {
          governance,
          // The route's resolver: the identity must be the configured
          // recipient of the workflow; the scope is the sender's.
          resolveAssignment: ({ identity: who }) =>
            Promise.resolve(
              who.supervisorId === BOB && who.principal === BOB_PRINCIPAL
                ? SENDER
                : undefined
            ),
        },
        identity,
        command
      ),
  });
  const result = await reconciler.reconcile();
  expect(result).toMatchObject({ acknowledged: 1, failed: 1 });
  expect(governed).toEqual([
    {
      claimant: BOB,
      operation: "claim",
      requestId: `a2a-ack:claim:${real}`,
      trustedScope: SENDER,
      workflowId: real,
    },
    {
      claimant: BOB,
      operation: "acknowledge",
      requestId: `a2a-ack:acknowledge:${real}`,
      trustedScope: SENDER,
      workflowId: real,
    },
  ]);
  expect(state.get(forged)).toBeUndefined();
});
