import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import {
  type A2AInboundMessage,
  agentCardFor,
  FROM_METADATA_KEY,
  SupervisorA2AAdapter,
  taskStateFor,
} from "../../src/loop/a2a-supervisor-adapter";
import { InMemoryWorkflowPort } from "../../src/loop/in-memory-workflow-port";
import {
  MailboxSupervisorMessageDeliveryPort,
  mailboxPathFor,
} from "../../src/loop/supervisor-mailbox-delivery";
import { SupervisorMessageCoordinator } from "../../src/loop/supervisor-message-coordinator";
import { GovernedSupervisorMessageService } from "../../src/loop/supervisor-message-governance";
import { supervisorMessageWorkflowDefinition } from "../../src/loop/supervisor-message-workflow";
import { SupervisorOrchestrationRuntime } from "../../src/loop/supervisor-orchestration-runtime";
import { JsonlSupervisorThreadStore } from "../../src/loop/supervisor-thread-store";

/**
 * Stage 1 of the A2A migration: the protocol's vocabulary translated onto the
 * runtime that already exists. What these tests are for is the SEAM — that a
 * message arriving in A2A's shape lands in the same governed workflow and the
 * same durable store as one arriving over the mailbox, and that the projection
 * back out does not overstate what happened.
 *
 * Scope: no transport, no network, no SDK server. The SDK is present only as
 * types and its TaskState enum, which is the point — the states asserted below
 * are the protocol's own values, not strings I chose.
 */
const SENDER = "supervisor:portfolio-coordinator";
const SENDER_PRINCIPAL = "principal:portfolio-coordinator";
const OTHER_PRINCIPAL = "principal:other-coordinator";
const RECIPIENT = "supervisor:harness-desktop";
const RECIPIENT_PRINCIPAL = "principal:harness-desktop";
const TENANT = "tenant:a2a-adapter";
const AT = "2026-09-20T03:00:00.000Z";

const POLICY = {
  claimTimeoutMs: 600_000,
  escalationTimeoutMs: 1_200_000,
  maxDeliveryAttempts: 3,
  retryDelayMs: 30_000,
};

/**
 * A2A's Part carries metadata, filename and mediaType alongside its content,
 * and all three are required. Built here so a test part is a real Part rather
 * than a convenient subset the compiler would reject.
 */
const part = (content: A2AInboundMessage["parts"][number]["content"]) => ({
  content,
  filename: "",
  mediaType: "",
  metadata: undefined,
});

const message = (overrides: Partial<A2AInboundMessage> = {}) =>
  ({
    contextId: "a2a-thread",
    messageId: "a2a-1",
    metadata: { [FROM_METADATA_KEY]: SENDER },
    parts: [part({ $case: "text", value: "A bounded request." })],
    ...overrides,
  }) as A2AInboundMessage;

const world = (
  root: string,
  allowedSenders: readonly string[] = [SENDER_PRINCIPAL]
) => {
  const runtime = new SupervisorOrchestrationRuntime({
    governed: new GovernedSupervisorMessageService({
      authority: {
        decide: (request) => {
          const expected =
            request.operation === "receive" || request.operation === "cancel"
              ? allowedSenders.includes(request.principal)
              : RECIPIENT_PRINCIPAL;
          const allowed =
            typeof expected === "boolean"
              ? expected
              : request.principal === expected;
          return {
            allowed,
            authorityRef: "authority:a2a",
            reasonCode: allowed ? "allowed" : "denied",
          };
        },
      },
      coordinator: new SupervisorMessageCoordinator(
        new InMemoryWorkflowPort({
          definitions: [supervisorMessageWorkflowDefinition],
          now: () => AT,
        }),
        new MailboxSupervisorMessageDeliveryPort({
          directory: {
            resolveMailbox: (id: string) => mailboxPathFor(root, id),
          },
          now: () => AT,
        })
      ),
      now: () => AT,
      receipts: { record: () => undefined },
    }),
    store: new JsonlSupervisorThreadStore(join(root, "threads.jsonl")),
  });
  return {
    adapter: new SupervisorA2AAdapter({
      now: () => AT,
      policy: POLICY,
      runtime,
      supervisorId: RECIPIENT,
    }),
    runtime,
  };
};

const withRoot = async (body: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), "a2a-adapter-"));
  try {
    await body(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

test("an A2A message/send lands in the governed workflow and the durable store", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const result = await w.adapter.sendMessage({
      message: message(),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });

    // Submitted, because it has been accepted and routed — not worked on.
    expect(result.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(result.contextId).toBe("a2a-thread");

    // The SAME durable store the mailbox path writes to, under the task id the
    // protocol caller was handed. Governance and the workflow stayed in the
    // path: nothing here bypasses them.
    const stored = w.runtime
      .threads()
      .threads.flatMap((thread) => thread.messages)
      .find((entry) => entry.item.workflowId === result.taskId);
    expect(stored?.item.phase).toBe("routed");
    expect(stored?.item.from).toBe(SENDER);
    expect(stored?.item.to).toBe(RECIPIENT);
  });
});

test("governance still refuses a principal with no grant, over A2A as over the mailbox", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.adapter.sendMessage({
        message: message(),
        // A principal the authority does not allow to route anything.
        principal: RECIPIENT_PRINCIPAL,
        tenant: TENANT,
      })
    ).rejects.toThrow();
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

/**
 * THE POINT of this file. A2A's task states describe the state of WORK, and
 * this module observes only the state of a MESSAGE. So no phase it can see is
 * allowed to report execution.
 *
 * An earlier version mapped `acknowledged` and `claimed` to WORKING, and review
 * rejected it: a recipient taking delivery, or a worker claiming the message,
 * is not evidence that the requested work started. That is the same
 * overstatement as calling an ack COMPLETED, one step smaller. Delivery lives
 * in the receipt layer; the task stays SUBMITTED until something that actually
 * watches execution can say otherwise.
 */
test("no message phase is ever projected as WORKING or COMPLETED", () => {
  const phases = [
    "acknowledged",
    "claimed",
    "escalated",
    "retry-scheduled",
    "routed",
  ] as const;
  for (const phase of phases) {
    expect(taskStateFor(phase)).toBe(TaskState.TASK_STATE_SUBMITTED);
    expect(taskStateFor(phase)).not.toBe(TaskState.TASK_STATE_WORKING);
    expect(taskStateFor(phase)).not.toBe(TaskState.TASK_STATE_COMPLETED);
  }
  // The terminal phases are outcomes of the REQUEST, not claims about
  // execution, so reporting them is safe.
  expect(taskStateFor("dead-lettered")).toBe(TaskState.TASK_STATE_FAILED);
  expect(taskStateFor("canceled")).toBe(TaskState.TASK_STATE_CANCELED);
});

test("a message with no sender in its metadata is refused rather than attributed", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.adapter.sendMessage({
        message: message({ metadata: {} }),
        principal: SENDER_PRINCIPAL,
        tenant: TENANT,
      })
    ).rejects.toThrow(FROM_METADATA_KEY);
    // And nothing was written on the way to refusing.
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

test("a message with no text is refused rather than routed empty", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.adapter.sendMessage({
        message: message({ parts: [] }),
        principal: SENDER_PRINCIPAL,
        tenant: TENANT,
      })
    ).rejects.toThrow("text part");
  });
});

/**
 * The card advertises text/plain and nothing else. An earlier version filtered
 * unsupported parts out and routed the remaining text, so a request carrying a
 * data part or a file alongside its instruction reached the recipient with that
 * context silently missing — a partial instruction that reads as a whole one.
 * Each case asserts the refusal AND that nothing durable was written on the way
 * to it.
 */
const mixed = [
  ["data", { $case: "data" as const, value: { attachment: 1 } }],
  ["raw", { $case: "raw" as const, value: Buffer.from("x") }],
  ["url", { $case: "url" as const, value: "https://example.invalid/spec" }],
] as const;

for (const [kind, content] of mixed) {
  test(`a request mixing text with a ${kind} part is refused, with no durable write`, async () => {
    await withRoot(async (root) => {
      const w = world(root);
      await expect(
        w.adapter.sendMessage({
          message: message({
            parts: [
              part({ $case: "text", value: "Do the thing described in" }),
              part(content),
            ],
          }),
          principal: SENDER_PRINCIPAL,
          tenant: TENANT,
        })
      ).rejects.toThrow(kind);
      expect(w.runtime.threads().threads).toHaveLength(0);
    });
  });
}

test("a part carrying no content at all is refused rather than skipped", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.adapter.sendMessage({
        message: message({
          parts: [
            part({ $case: "text", value: "Instruction" }),
            part(undefined),
          ],
        }),
        principal: SENDER_PRINCIPAL,
        tenant: TENANT,
      })
    ).rejects.toThrow("empty");
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});

test("the agent card names the supervisor identity the rest of the system uses", () => {
  const card = agentCardFor({
    description: "Harness engineering supervisor.",
    supervisorId: RECIPIENT,
    url: "http://127.0.0.1:8791/a2a",
  });
  expect(card.name).toBe(RECIPIENT);
  expect(card.skills[0]?.id).toBe(`${RECIPIENT}:receive`);
  // Declared honestly: neither capability is implemented at stage 1.
  expect(card.capabilities?.streaming).toBe(false);
  expect(card.capabilities?.pushNotifications).toBe(false);
});

/**
 * Stage 2's precondition: an A2A message id has to name the same task every
 * time, including after a restart, or retiring the bespoke envelope would lose
 * deduplication.
 *
 * The id is content-addressed — sha256 of the dedupe key, which this adapter
 * scopes to the trusted tenant and authenticated principal plus the raw A2A
 * message id — so identity is pure derivation and survives a restart by
 * construction rather than by stored state. That is the half these tests can
 * prove. The other half, whether a repeated id is refused or replayed
 * idempotently by a DURABLE workflow port, lives in Temporal and is NOT proven
 * here: the port below is in-memory, and letting it stand in for Temporal would
 * be exactly the substitution this file is meant to avoid.
 */
test("the same A2A message id names the same task, and does not route twice", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const first = await w.adapter.sendMessage({
      message: message(),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    const second = await w.adapter.sendMessage({
      message: message({
        parts: [part({ $case: "text", value: "Resent." })],
      }),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    // Same id in, same task out, even though the body differed.
    expect(second.taskId).toBe(first.taskId);
    const stored = w.runtime
      .threads()
      .threads.flatMap((entry) => entry.messages)
      .filter((entry) => entry.item.workflowId === first.taskId);

    // One entry, not two, and its delivery count did not move: the resend was
    // absorbed rather than routed a second time. The board read model carries
    // no message body, so "the first body won" is not observable here and is
    // not asserted -- what IS asserted is that nothing was delivered twice.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.item.messageId).toBe("a2a-1");
    expect(stored[0]?.item.deliveryAttempts).toBe(1);
  });
});

test("a different A2A message id names a different task", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    const first = await w.adapter.sendMessage({
      message: message(),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    const other = await w.adapter.sendMessage({
      message: message({ messageId: "a2a-2" }),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    expect(other.taskId).not.toBe(first.taskId);
  });
});

test("tenant and authenticated principal namespace a raw message id before Temporal", async () => {
  await withRoot(async (root) => {
    const w = world(root, [SENDER_PRINCIPAL, OTHER_PRINCIPAL]);
    const first = await w.adapter.sendMessage({
      message: message(),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    const sameScopeRetry = await w.adapter.sendMessage({
      message: message({
        contextId: "changed-context-does-not-repeat-work",
        metadata: { [FROM_METADATA_KEY]: "supervisor:changed-claim" },
      }),
      principal: SENDER_PRINCIPAL,
      tenant: TENANT,
    });
    const otherTenant = await w.adapter.sendMessage({
      message: message(),
      principal: SENDER_PRINCIPAL,
      tenant: "tenant:other",
    });
    const otherPrincipal = await w.adapter.sendMessage({
      message: message(),
      principal: OTHER_PRINCIPAL,
      tenant: TENANT,
    });

    expect(sameScopeRetry.taskId).toBe(first.taskId);
    expect(sameScopeRetry.scopeId).toBe(first.scopeId);
    expect(otherTenant.taskId).not.toBe(first.taskId);
    expect(otherTenant.scopeId).not.toBe(first.scopeId);
    expect(otherPrincipal.taskId).not.toBe(first.taskId);
    expect(otherPrincipal.scopeId).not.toBe(first.scopeId);
    expect(otherPrincipal.taskId).not.toBe(otherTenant.taskId);
    expect(w.runtime.threads().threads).toHaveLength(3);
  });
});

test("a direct adapter caller without a tenant is refused before it writes", async () => {
  await withRoot(async (root) => {
    const w = world(root);
    await expect(
      w.adapter.sendMessage({
        message: message(),
        principal: SENDER_PRINCIPAL,
        tenant: "",
      })
    ).rejects.toThrow("non-empty tenant");
    expect(w.runtime.threads().threads).toHaveLength(0);
  });
});
