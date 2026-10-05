import { createHash } from "node:crypto";
import { type AgentCard, type Message, TaskState } from "@a2a-js/sdk";
import type {
  SupervisorMessagePolicy,
  SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import type { SupervisorOrchestrationRuntime } from "./supervisor-orchestration-runtime";

/**
 * Stage 1 of the A2A migration: the protocol's vocabulary mapped onto the
 * supervisor runtime that already exists, added ALONGSIDE the current path
 * rather than replacing it. Governance, the workflow and its durable thread
 * store stay in the path unchanged — this module only translates.
 *
 * What it deliberately does NOT do, settled from the installed SDK rather than
 * from the protocol's prose: it does not project an acknowledgment as a
 * COMPLETED task. A2A's task states describe what the WORK is doing, and the
 * protocol has no per-message delivery receipt, so the local explicit-key ack
 * and cursor remain the only thing that records "this recipient took delivery
 * of this exact message". Mapping an ack to COMPLETED would silently claim the
 * requested work was finished. See a2a-reuse-assessment.md §7.
 *
 * The SDK's own AgentCard, Message and TaskState are imported so the mapping
 * is checked against the protocol rather than against my reading of it: a card
 * that omits a required field, or a field I misremembered the name of, fails to
 * compile here instead of failing against a peer. No server and no network —
 * wiring this to a transport is stage 2's problem.
 */

// The id under which a caller names itself. A2A's Message carries no sender
// identity, and the supervisor workflow refuses a message without one, so the
// adapter demands it explicitly rather than inventing a plausible sender.
export const FROM_METADATA_KEY = "harness.dev/from";
const AGENT_CARD_VERSION = "1.0.0";
const PROTOCOL_VERSION = "1.0";
const TEXT_MODE = "text/plain";

/**
 * The states this adapter can produce, drawn from the SDK's own enum. WORKING
 * and COMPLETED are absent on purpose: see `taskStateFor`.
 */
export type A2ATaskState =
  | TaskState.TASK_STATE_CANCELED
  | TaskState.TASK_STATE_FAILED
  | TaskState.TASK_STATE_SUBMITTED;

/**
 * Only the fields an inbound request is read for. Narrowed from the protocol's
 * own Message so the field names cannot drift from it.
 */
export type A2AInboundMessage = Pick<
  Message,
  "contextId" | "messageId" | "metadata" | "parts"
>;

/**
 * A deterministic shape failure that is safe to reject before the SDK creates
 * or updates a task. The request-handler boundary maps this to the SDK's
 * `RequestMalformedError`; the adapter also uses it defensively for callers
 * that invoke the executor without that handler.
 */
export class SupervisorA2ARequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorA2ARequestValidationError";
  }
}

export interface ValidatedSupervisorA2ARequest {
  body: string;
  from: string;
  messageId: string;
}

/**
 * The trusted A2A ingress scope projected into every existing canonical
 * identity boundary. It is deliberately derived from the authenticated
 * principal and route-bound tenant, never from message metadata.
 *
 * The generic supervisor workflow predates A2A tenants. Rather than inventing
 * a second scheduler or persist a parallel scope ledger, A2A derives stable,
 * opaque values for the workflow dedupe key, internal thread id, and command
 * request id that already name every durable effect. That makes a same-looking
 * A2A message from two tenant/principal scopes distinct before it reaches
 * Temporal, while a same-scope retry resolves to the exact same effect.
 */
export interface CanonicalSupervisorA2AIdentity {
  dedupeKey: string;
  requestId: string;
  scopeId: string;
  threadId: string;
}

/**
 * One card per supervisor identity. The identity is the supervisor id already
 * used by governance and the mailbox, so a card cannot describe an agent the
 * rest of the system does not know about.
 */
export const agentCardFor = (input: {
  description: string;
  supervisorId: string;
  url: string;
}): AgentCard => ({
  capabilities: {
    extensions: [],
    // Both false, and true only once proven: nothing here streams, and the
    // push path is stage 3.
    pushNotifications: false,
    streaming: false,
  },
  defaultInputModes: [TEXT_MODE],
  defaultOutputModes: [TEXT_MODE],
  description: input.description,
  name: input.supervisorId,
  // Empty rather than invented: this adapter carries no provider identity, and
  // authentication is the transport's to declare once stage 2 gives it one.
  provider: undefined,
  securityRequirements: [],
  securitySchemes: {},
  signatures: [],
  skills: [
    {
      description:
        "Accepts a bounded request addressed to this supervisor. Acceptance is not completion: the requesting party learns the outcome from the task's own state, and delivery is recorded separately by the recipient's acknowledgment.",
      id: `${input.supervisorId}:receive`,
      examples: [],
      inputModes: [TEXT_MODE],
      name: "receive",
      outputModes: [TEXT_MODE],
      securityRequirements: [],
      tags: ["supervisor", "orchestration"],
    },
  ],
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: PROTOCOL_VERSION,
      tenant: "",
      url: input.url,
    },
  ],
  version: AGENT_CARD_VERSION,
});

/**
 * Projects a supervisor message's phase onto an A2A task state.
 *
 * Every non-terminal phase is SUBMITTED, and that is deliberate.
 *
 * Review corrected an earlier version of this function (2026-09-20) that mapped
 * `acknowledged` and `claimed` to WORKING. Both of those phases are facts about
 * the MESSAGE — it reached a mailbox, a recipient took delivery of it, a worker
 * claimed it — and none of them is evidence that the requested work has begun.
 * Projecting WORKING from a receipt would report execution this module cannot
 * observe, which is exactly the overstatement the COMPLETED mapping was rejected
 * for. So delivery state stays where it belongs, in the receipt layer, and the
 * task state stays SUBMITTED until something that actually watches execution can
 * supply the evidence. WORKING is therefore not in this function's range at all;
 * adding it is a change of evidence, not a change of mapping.
 *
 * The terminal phases are different: dead-lettered and canceled are outcomes of
 * the request itself, and reporting them is not a claim about execution.
 */
export const taskStateFor = (
  phase: SupervisorMessageProjection["phase"]
): A2ATaskState => {
  if (phase === "canceled") {
    return TaskState.TASK_STATE_CANCELED;
  }
  if (phase === "dead-lettered") {
    return TaskState.TASK_STATE_FAILED;
  }
  return TaskState.TASK_STATE_SUBMITTED;
};

/**
 * Reads the request text, and REFUSES anything this adapter cannot carry.
 *
 * Review found (2026-09-20) that an earlier version filtered non-text parts out
 * and joined what was left, so a request carrying a data part or a file
 * alongside its text executed with that context silently missing — the
 * recipient would act on a partial instruction believing it whole. The agent
 * card advertises text/plain and nothing else, so an unsupported part is a
 * request this agent cannot honour, and saying so is the only safe answer.
 */
const textOf = (message: A2AInboundMessage): string => {
  if (!Array.isArray(message.parts)) {
    throw new SupervisorA2ARequestValidationError(
      "an A2A message for a supervisor needs a parts array"
    );
  }
  const unsupported = new Set(
    message.parts
      .map((part) => part.content?.$case ?? "empty")
      .filter((kind) => kind !== "text")
  );
  if (unsupported.size > 0) {
    throw new SupervisorA2ARequestValidationError(
      `an A2A message for a supervisor supports ${TEXT_MODE} parts only, and this one carries: ${[...unsupported].sort().join(", ")}`
    );
  }
  const text = message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("");
  if (!text.trim()) {
    throw new SupervisorA2ARequestValidationError(
      "an A2A message for a supervisor needs a text part"
    );
  }
  return text;
};

const senderOf = (message: A2AInboundMessage): string => {
  const from = message.metadata?.[FROM_METADATA_KEY];
  if (typeof from !== "string" || !from.trim()) {
    throw new SupervisorA2ARequestValidationError(
      `an A2A message for a supervisor needs metadata ${FROM_METADATA_KEY} naming its sender`
    );
  }
  return from;
};

const messageIdOf = (message: A2AInboundMessage): string => {
  if (typeof message.messageId !== "string" || !message.messageId.trim()) {
    throw new SupervisorA2ARequestValidationError(
      "an A2A message for a supervisor needs a message id"
    );
  }
  return message.messageId;
};

export const contextIdOf = (message: A2AInboundMessage): string => {
  if (typeof message.contextId !== "string" || !message.contextId.trim()) {
    throw new SupervisorA2ARequestValidationError(
      "an A2A message for a supervisor needs a context id"
    );
  }
  return message.contextId;
};

const scopeValueOf = (kind: string, value: string): string => {
  if (!value.trim()) {
    throw new SupervisorA2ARequestValidationError(
      `an A2A message for a supervisor needs a non-empty ${kind}`
    );
  }
  return value;
};

/**
 * Parses the complete inbound shape once, so the SDK request boundary and the
 * runtime adapter accept exactly the same request vocabulary. This is kept
 * pure: no governance decision, task-store access, workflow start, receipt,
 * or thread write occurs here.
 */
export const validateSupervisorA2ARequest = (
  message: A2AInboundMessage
): ValidatedSupervisorA2ARequest => {
  return {
    body: textOf(message),
    from: senderOf(message),
    messageId: messageIdOf(message),
  };
};

const scopeDigest = (...parts: readonly string[]): string =>
  parts
    .reduce(
      (hash, part) =>
        hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part),
      createHash("sha256").update("harness-supervisor-a2a-scope.v1\u0000")
    )
    .digest("hex");

const stableA2AIdentifier = (kind: string, digest: string): string =>
  `a2a:${kind}:${digest}`;

/**
 * Derives every identity that crosses into the existing supervisor runtime.
 * Delivery is scoped only by trusted tenant, authenticated principal, target
 * supervisor, and the producer's raw message id. `from` is intentionally not
 * in that fingerprint: it remains a governed sender claim, and allowing a
 * caller to change it would incorrectly turn a retry of the same message into
 * a new durable effect. The context id instead identifies the scoped
 * projection thread, not the work item.
 */
export const canonicalSupervisorA2AIdentity = (input: {
  contextId: string;
  messageId: string;
  principal: string;
  supervisorId: string;
  tenant: string;
}): CanonicalSupervisorA2AIdentity => {
  const scope = [
    scopeValueOf("tenant", input.tenant),
    scopeValueOf("authenticated principal", input.principal),
    scopeValueOf("target supervisor", input.supervisorId),
  ] as const;
  const scopeId = stableA2AIdentifier("scope", scopeDigest(...scope));
  const messageDigest = scopeDigest("message", ...scope, input.messageId);
  return {
    dedupeKey: stableA2AIdentifier("dedupe", messageDigest),
    requestId: stableA2AIdentifier("send", messageDigest),
    scopeId,
    threadId: stableA2AIdentifier(
      "thread",
      scopeDigest("thread", ...scope, input.contextId)
    ),
  };
};

export interface A2ASendResult {
  contextId: string;
  scopeId: string;
  state: A2ATaskState;
  taskId: string;
}

export interface SupervisorA2AAdapterOptions {
  now: () => string;
  policy: SupervisorMessagePolicy;
  runtime: SupervisorOrchestrationRuntime;
  supervisorId: string;
}

export class SupervisorA2AAdapter {
  readonly #now: () => string;
  readonly #policy: SupervisorMessagePolicy;
  readonly #runtime: SupervisorOrchestrationRuntime;
  readonly #supervisorId: string;

  constructor(options: SupervisorA2AAdapterOptions) {
    this.#now = options.now;
    this.#policy = options.policy;
    this.#runtime = options.runtime;
    this.#supervisorId = options.supervisorId;
  }

  /**
   * `message/send` onto the runtime's own receive. The principal is the
   * caller's authenticated identity and is NOT read from the message: a
   * sender naming itself in metadata says who it claims to be, and governance
   * still decides whether that principal may route anything at all.
   */
  async sendMessage(input: {
    message: A2AInboundMessage;
    principal: string;
    tenant: string;
  }): Promise<A2ASendResult> {
    const validated = validateSupervisorA2ARequest(input.message);
    // The A2A SDK permits an initial client message without contextId and
    // generates one before invoking this executor. Direct adapter callers do
    // not have that SDK lifecycle, so keep this requirement here rather than
    // rejecting a valid initial wire request in the prevalidation handler.
    const contextId = contextIdOf(input.message);
    const identity = canonicalSupervisorA2AIdentity({
      contextId,
      messageId: validated.messageId,
      principal: input.principal,
      supervisorId: this.#supervisorId,
      tenant: input.tenant,
    });
    const received = await this.#runtime.receive({
      input: {
        artifactRefs: [],
        body: validated.body,
        dedupeKey: identity.dedupeKey,
        from: validated.from,
        messageId: validated.messageId,
        policy: this.#policy,
        receivedAt: this.#now(),
        threadId: identity.threadId,
        to: this.#supervisorId,
      },
      messageKind: "question",
      principal: input.principal,
      requestId: identity.requestId,
    });
    return {
      contextId,
      scopeId: identity.scopeId,
      state: taskStateFor(received.projection.phase),
      taskId: received.workflowId,
    };
  }
}
