import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchBridgeMessage } from "../../src/loop/bridge-dispatch";
import {
  readBridgeEvents,
  readPendingBridgeMessages,
} from "../../src/loop/bridge-store";
import {
  BridgeSupervisorMessageDeliveryPort,
  type SupervisorBridgeDispatch,
} from "../../src/loop/bridge-supervisor-message-delivery";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  JsonlSupervisorMessageReceiptPort,
  type SupervisorMessageAuthorityDecision,
  type SupervisorMessageAuthorityRequest,
  SupervisorMessageGovernanceError,
} from "../../src/loop/supervisor-message-governance";
import {
  type SupervisorMessageDeliveryRequest,
  type SupervisorMessageInput,
  supervisorMessageWorkflowDefinition,
} from "../../src/loop/supervisor-message-workflow";
import { WorkflowError } from "../../src/loop/workflow-port";

const ARTIFACT_REF = `artifact://sha256/${"c".repeat(64)}`;
const AT = "2026-08-30T06:10:00.000Z";
const BODY = "bounded request body /Users/private.txt token=never-project";
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const input = (): SupervisorMessageInput => ({
  artifactRefs: [ARTIFACT_REF],
  body: BODY,
  dedupeKey: "governed-message-1",
  from: "supervisor:source",
  messageId: "message-governed-1",
  policy: {
    claimTimeoutMs: 1000,
    escalationTimeoutMs: 2000,
    maxDeliveryAttempts: 2,
    retryDelayMs: 500,
  },
  receivedAt: AT,
  threadId: "thread-governed-1",
  to: "supervisor:target",
});

const setup = (decision: SupervisorMessageAuthorityDecision) => {
  const root = mkdtempSync(join(tmpdir(), "governed-supervisor-message-"));
  tempRoots.push(root);
  const runDir = join(root, "target-run");
  const receiptFile = join(root, "governance", "receipts.jsonl");
  let currentDecision = decision;
  const authorityCalls: SupervisorMessageAuthorityRequest[] = [];
  const workflows = new InMemoryWorkflowPort({
    definitions: [supervisorMessageWorkflowDefinition],
    now: () => AT,
  });
  const delivery = new BridgeSupervisorMessageDeliveryPort({
    directory: {
      resolve: (supervisorId) =>
        supervisorId === "supervisor:target"
          ? { runDir, target: "supervisor" }
          : undefined,
    },
    dispatch: async (route, request, now) => {
      const result = await dispatchBridgeMessage(
        route.runDir,
        "supervisor",
        route.target,
        request.body,
        undefined,
        undefined,
        {
          artifactRefs: request.artifactRefs,
          dedupeKey: request.idempotencyKey,
          now,
          subject: request.messageId,
          taskId: request.workflowId,
          threadId: request.threadId,
          type: "work_request",
        }
      );
      return { ...result, status: "accepted" };
    },
    now: () => AT,
  });
  const coordinator = new SupervisorMessageCoordinator(workflows, delivery);
  const service = new GovernedSupervisorMessageService({
    authority: {
      decide: (request) => {
        authorityCalls.push(structuredClone(request));
        return currentDecision;
      },
    },
    coordinator,
    now: () => AT,
    receipts: new JsonlSupervisorMessageReceiptPort(receiptFile),
  });
  return {
    authorityCalls,
    delivery,
    receiptFile,
    runDir,
    setDecision: (next: SupervisorMessageAuthorityDecision) => {
      currentDecision = next;
    },
    service,
    workflows,
  };
};

describe("governed SupervisorMessage delivery", () => {
  test("authorizes, durably enqueues once, claims, and acknowledges", async () => {
    const harness = setup({
      allowed: true,
      authorityRef: "grant:supervisor-message-1",
      reasonCode: "scope-allowed",
    });
    const received = await harness.service.receive(
      "workload:source",
      input(),
      "receive-1"
    );
    expect(received.projection).toMatchObject({
      actionRequired: "claim",
      deliveryAttempts: 1,
      phase: "routed",
    });
    const pending = readPendingBridgeMessages(harness.runDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      artifactRefs: [ARTIFACT_REF],
      dedupeKey: `${received.workflowId}:delivery:1`,
      message: BODY,
      subject: "message-governed-1",
      target: "supervisor",
      threadId: "thread-governed-1",
      type: "work_request",
    });

    const claimed = await harness.service.claim({
      claimant: "supervisor:target",
      principal: "workload:target",
      requestId: "claim-1",
      workflowId: received.workflowId,
    });
    expect(claimed.phase).toBe("claimed");
    const acknowledged = await harness.service.acknowledge({
      claimant: "supervisor:target",
      principal: "workload:target",
      requestId: "ack-1",
      workflowId: received.workflowId,
    });
    expect(acknowledged.phase).toBe("acknowledged");
    expect(harness.authorityCalls.map((call) => call.operation)).toEqual([
      "receive",
      "claim",
      "acknowledge",
    ]);

    const receiptText = readFileSync(harness.receiptFile, "utf8");
    expect(receiptText).not.toContain(BODY);
    expect(receiptText).not.toContain("/Users/");
    expect(receiptText).not.toContain("token=");
    const receipts = receiptText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(receipts).toHaveLength(3);
    expect(receipts.every((receipt) => receipt.decision === "allowed")).toBe(
      true
    );
  });

  test("denies before workflow and bridge mutation and records no body", async () => {
    const harness = setup({
      allowed: false,
      authorityRef: "denial:cross-project",
      reasonCode: "scope-denied",
    });
    await expect(
      harness.service.receive("workload:source", input(), "receive-denied")
    ).rejects.toBeInstanceOf(SupervisorMessageGovernanceError);
    expect(readPendingBridgeMessages(harness.runDir)).toEqual([]);
    expect(() =>
      harness.workflows.inspect("supervisor-message:missing")
    ).toThrow(WorkflowError);
    const receiptText = readFileSync(harness.receiptFile, "utf8");
    expect(receiptText).toContain('"decision":"denied"');
    expect(receiptText).not.toContain(BODY);
  });

  test("denies a claim without advancing the existing workflow", async () => {
    const harness = setup({
      allowed: true,
      authorityRef: "grant:receive",
      reasonCode: "scope-allowed",
    });
    const received = await harness.service.receive(
      "workload:source",
      input(),
      "receive-claim-denial"
    );
    harness.setDecision({
      allowed: false,
      authorityRef: "denial:claim",
      reasonCode: "claim-scope-denied",
    });
    await expect(
      harness.service.claim({
        claimant: "supervisor:target",
        principal: "workload:target",
        requestId: "claim-denied",
        workflowId: received.workflowId,
      })
    ).rejects.toBeInstanceOf(SupervisorMessageGovernanceError);
    expect(harness.workflows.inspect(received.workflowId)).toMatchObject({
      revision: 2,
      status: "running",
    });
    const receipts = readFileSync(harness.receiptFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(receipts.at(-1)).toMatchObject({
      decision: "denied",
      operation: "claim",
      workflowId: received.workflowId,
    });
  });

  test("refuses malformed input before authority and emits validation receipt", async () => {
    const harness = setup({
      allowed: true,
      authorityRef: "grant:unused",
      reasonCode: "scope-allowed",
    });
    await expect(
      harness.service.receive(
        "workload:source",
        { ...input(), receivedAt: "2026-02-30T00:00:00.000Z" },
        "receive-invalid"
      )
    ).rejects.toBeInstanceOf(WorkflowError);
    expect(harness.authorityCalls).toEqual([]);
    expect(readPendingBridgeMessages(harness.runDir)).toEqual([]);
    const receiptText = readFileSync(harness.receiptFile, "utf8");
    expect(receiptText).toContain('"authorityRef":"input-validation"');
    expect(receiptText).not.toContain(BODY);
  });

  test("deduplicates activity calls and maps route and terminal failures", async () => {
    const harness = setup({
      allowed: true,
      authorityRef: "grant:unused",
      reasonCode: "scope-allowed",
    });
    const request: SupervisorMessageDeliveryRequest = {
      artifactRefs: [ARTIFACT_REF],
      body: BODY,
      idempotencyKey: "workflow:delivery:1",
      messageId: "message-governed-1",
      target: "supervisor:target",
      threadId: "thread-governed-1",
      workflowId: `supervisor-message:${"f".repeat(64)}`,
    };
    expect(await harness.delivery.deliver(request)).toEqual({
      status: "accepted",
    });
    expect(await harness.delivery.deliver(request)).toEqual({
      status: "accepted",
    });
    expect(readPendingBridgeMessages(harness.runDir)).toHaveLength(1);

    const unresolved = new BridgeSupervisorMessageDeliveryPort({
      directory: { resolve: () => undefined },
    });
    expect(await unresolved.deliver(request)).toEqual({
      reason: "no trusted bridge route for supervisor:target",
      status: "transient-failure",
    });

    const terminalDispatch: SupervisorBridgeDispatch = async (
      route,
      _request
    ) => ({
      entry: readPendingBridgeMessages(harness.runDir)[0],
      reason: "retention expired",
      status: "expired",
      target: route.target,
    });
    const terminal = new BridgeSupervisorMessageDeliveryPort({
      directory: {
        resolve: () => ({ runDir: harness.runDir, target: "supervisor" }),
      },
      dispatch: terminalDispatch,
    });
    expect(await terminal.deliver(request)).toEqual({
      reason: "retention expired",
      status: "permanent-failure",
    });
  });

  test("does not enqueue before route readiness and retries with one durable body", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervisor-route-retry-"));
    tempRoots.push(root);
    const runDir = join(root, "target-run");
    let ready = false;
    const request: SupervisorMessageDeliveryRequest = {
      artifactRefs: [ARTIFACT_REF],
      body: BODY,
      idempotencyKey: "workflow:delivery:1",
      messageId: "message-route-retry-1",
      target: "supervisor:target",
      threadId: "thread-route-retry-1",
      workflowId: `supervisor-message:${"e".repeat(64)}`,
    };
    const delivery = new BridgeSupervisorMessageDeliveryPort({
      directory: {
        resolve: () => ({ runDir, target: "codex" }),
      },
      dispatch: (route, next, now) =>
        dispatchBridgeMessage(
          route.runDir,
          "supervisor",
          route.target,
          next.body,
          undefined,
          undefined,
          {
            artifactRefs: next.artifactRefs,
            dedupeKey: next.idempotencyKey,
            now,
            subject: next.messageId,
            taskId: next.workflowId,
            threadId: next.threadId,
            type: "work_request",
          }
        ),
      now: () => AT,
      routeReady: () => ready,
    });

    expect(await delivery.deliver(request)).toEqual({
      reason: "bridge route for supervisor:target is unavailable",
      status: "transient-failure",
    });
    expect(readPendingBridgeMessages(runDir)).toEqual([]);

    ready = true;
    expect(
      await delivery.deliver({
        ...request,
        idempotencyKey: "workflow:delivery:2",
      })
    ).toEqual({ status: "accepted" });
    expect(readPendingBridgeMessages(runDir)).toHaveLength(1);
    expect(readPendingBridgeMessages(runDir)[0]).toMatchObject({
      dedupeKey: "workflow:delivery:2",
      message: BODY,
      target: "codex",
    });
  });

  test("keeps a durable enqueue accepted when the transcript mirror fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervisor-transcript-failure-"));
    tempRoots.push(root);
    const runDir = join(root, "target-run");
    mkdirSync(join(runDir, "transcript.jsonl"), { recursive: true });
    const request: SupervisorMessageDeliveryRequest = {
      artifactRefs: [ARTIFACT_REF],
      body: BODY,
      idempotencyKey: "workflow:delivery:1",
      messageId: "message-transcript-failure-1",
      target: "supervisor:target",
      threadId: "thread-transcript-failure-1",
      workflowId: `supervisor-message:${"d".repeat(64)}`,
    };
    const delivery = new BridgeSupervisorMessageDeliveryPort({
      directory: {
        resolve: () => ({ runDir, target: "codex" }),
      },
      dispatch: (route, next, now) =>
        dispatchBridgeMessage(
          route.runDir,
          "supervisor",
          route.target,
          next.body,
          undefined,
          undefined,
          {
            artifactRefs: next.artifactRefs,
            dedupeKey: next.idempotencyKey,
            now,
            subject: next.messageId,
            taskId: next.workflowId,
            threadId: next.threadId,
            type: "work_request",
          }
        ),
      now: () => AT,
      routeReady: () => true,
    });

    expect(await delivery.deliver(request)).toEqual({ status: "accepted" });
    expect(readPendingBridgeMessages(runDir)).toHaveLength(1);
    expect(readPendingBridgeMessages(runDir)[0]).toMatchObject({
      dedupeKey: "workflow:delivery:1",
      message: BODY,
      target: "codex",
    });
    expect(readBridgeEvents(runDir).at(-1)).toMatchObject({
      id: readPendingBridgeMessages(runDir)[0]?.id,
      kind: "delivery-failed",
      reason: "transcript mirror unavailable after durable bridge enqueue",
    });
  });
});
