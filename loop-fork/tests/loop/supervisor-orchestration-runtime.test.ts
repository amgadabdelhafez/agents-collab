import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import {
  GovernedSupervisorMessageService,
  type SupervisorMessageAuthorityRequest,
  type SupervisorMessageGovernanceReceipt,
} from "../../src/loop/supervisor-message-governance";
import type { SupervisorMessageDeliveryRequest } from "../../src/loop/supervisor-message-workflow";
import { supervisorMessageWorkflowDefinition } from "../../src/loop/supervisor-message-workflow";
import { SupervisorOrchestrationRuntime } from "../../src/loop/supervisor-orchestration-runtime";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";

const artifactRef = `artifact://sha256/${"a".repeat(64)}`;

const messageInput = () => ({
  artifactRefs: [artifactRef],
  body: "Please approve the bounded runtime integration.",
  dedupeKey: "runtime-message-1",
  from: "supervisor:harvto",
  messageId: "runtime-message-1",
  policy: {
    claimTimeoutMs: 60_000,
    escalationTimeoutMs: 120_000,
    maxDeliveryAttempts: 3,
    retryDelayMs: 1000,
  },
  receivedAt: "2026-08-30T07:00:00.000Z",
  threadId: "runtime-thread-1",
  to: "supervisor:harness",
});

const createRuntime = (root: string, allowed = true) => {
  const deliveries: SupervisorMessageDeliveryRequest[] = [];
  const authority: SupervisorMessageAuthorityRequest[] = [];
  const receipts: SupervisorMessageGovernanceReceipt[] = [];
  const workflows = new InMemoryWorkflowPort({
    definitions: [supervisorMessageWorkflowDefinition],
    now: () => "2026-08-30T07:00:01.000Z",
  });
  const coordinator = new SupervisorMessageCoordinator(workflows, {
    deliver: (request) => {
      deliveries.push(structuredClone(request));
      return Promise.resolve({ status: "accepted" as const });
    },
  });
  const governed = new GovernedSupervisorMessageService({
    authority: {
      decide: (request) => {
        authority.push(structuredClone(request));
        return {
          allowed,
          authorityRef: "authority:runtime-test",
          reasonCode: allowed ? "allowed" : "denied",
        };
      },
    },
    coordinator,
    now: () => "2026-08-30T07:00:01.000Z",
    receipts: {
      record: (receipt) => {
        receipts.push(structuredClone(receipt));
      },
    },
  });
  const store = new JsonlSupervisorThreadStore(join(root, "threads.jsonl"));
  return {
    authority,
    deliveries,
    receipts,
    runtime: new SupervisorOrchestrationRuntime({ governed, store }),
    store,
  };
};

describe("SupervisorOrchestrationRuntime", () => {
  test("governs, delivers, persists, claims, acknowledges, and fresh-reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-runtime-"));
    try {
      const { deliveries, runtime, store } = createRuntime(root);
      const received = await runtime.receive({
        input: messageInput(),
        messageKind: "question",
        principal: "principal:harvto",
        requestId: "receive-1",
      });
      await runtime.claim({
        claimant: "supervisor:harness",
        principal: "principal:harness",
        requestId: "claim-1",
        workflowId: received.workflowId,
      });
      await runtime.acknowledge({
        claimant: "supervisor:harness",
        principal: "principal:harness",
        requestId: "ack-1",
        workflowId: received.workflowId,
      });

      expect(deliveries).toHaveLength(1);
      expect(runtime.threads()).toMatchObject({ revision: 3 });
      expect(runtime.threads().threads[0]?.messages[0]).toMatchObject({
        item: { phase: "acknowledged", workflowId: received.workflowId },
        messageKind: "question",
      });
      expect(runtime.attention().items).toMatchObject([
        { messageKind: "question", phase: "acknowledged" },
      ]);
      expect(runtime.knowledge()).toMatchObject({
        artifacts: [{ artifactRef, referenceCount: 1 }],
        sourceRevision: 3,
      });

      const restarted = new SupervisorOrchestrationRuntime({
        governed: {} as GovernedSupervisorMessageService,
        store,
      });
      expect(restarted.threads()).toEqual(runtime.threads());
      expect(restarted.attention()).toEqual(runtime.attention());
      expect(restarted.knowledge()).toEqual(runtime.knowledge());
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("replays workflow and journal commands without duplication", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-runtime-replay-"));
    try {
      const { runtime } = createRuntime(root);
      const command = {
        input: messageInput(),
        messageKind: "informational" as const,
        principal: "principal:harvto",
        requestId: "receive-replay",
      };
      const first = await runtime.receive(command);
      const second = await runtime.receive(command);
      expect(second).toEqual({ ...first, created: false });
      expect(runtime.threads().revision).toBe(1);
      expect(runtime.attention().items).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("denial creates neither workflow delivery nor durable thread", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-runtime-denied-"));
    try {
      const { authority, deliveries, receipts, runtime } = createRuntime(
        root,
        false
      );
      await expect(
        runtime.receive({
          input: messageInput(),
          messageKind: "authority-decision",
          principal: "principal:harvto",
          requestId: "receive-denied",
        })
      ).rejects.toThrow("authority denied");
      expect(authority).toHaveLength(1);
      expect(receipts).toMatchObject([{ decision: "denied" }]);
      expect(deliveries).toEqual([]);
      expect(runtime.threads()).toMatchObject({ revision: 0, threads: [] });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("refuses an existing mutation before authority when category is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-runtime-category-"));
    try {
      const { authority, runtime } = createRuntime(root);
      await expect(
        runtime.claim({
          claimant: "supervisor:harness",
          principal: "principal:harness",
          requestId: "claim-missing",
          workflowId: `supervisor-message:${"b".repeat(64)}`,
        })
      ).rejects.toThrow("no unique durable message category");
      expect(authority).toEqual([]);
      expect(runtime.threads().revision).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
