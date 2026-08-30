import { createHash } from "node:crypto";
import {
  SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
  type SupervisorMessageDeliveryRequest,
  type SupervisorMessageInput,
  type SupervisorMessageProjection,
} from "./supervisor-message-workflow";
import type { JsonObject, WorkflowPort } from "./workflow-port";

export type SupervisorMessageDeliveryOutcome =
  | { status: "accepted" }
  | { reason: string; status: "permanent-failure" | "transient-failure" };

export interface SupervisorMessageDeliveryPort {
  deliver(
    request: SupervisorMessageDeliveryRequest
  ): Promise<SupervisorMessageDeliveryOutcome>;
}

export interface SupervisorMessageReceiveResult {
  created: boolean;
  projection: SupervisorMessageProjection;
  workflowId: string;
}

const workflowIdFor = (dedupeKey: string): string =>
  `supervisor-message:${createHash("sha256").update(dedupeKey).digest("hex")}`;

const asProjection = (value: unknown): SupervisorMessageProjection =>
  value as SupervisorMessageProjection;

const asDeliveryRequest = (value: unknown): SupervisorMessageDeliveryRequest =>
  value as SupervisorMessageDeliveryRequest;

export class SupervisorMessageCoordinator {
  readonly #delivery: SupervisorMessageDeliveryPort;
  readonly #workflows: WorkflowPort;

  constructor(
    workflows: WorkflowPort,
    delivery: SupervisorMessageDeliveryPort
  ) {
    this.#workflows = workflows;
    this.#delivery = delivery;
  }

  async receive(
    input: SupervisorMessageInput,
    requestId: string
  ): Promise<SupervisorMessageReceiveResult> {
    const workflowId = workflowIdFor(input.dedupeKey);
    const started = await this.#workflows.start({
      input,
      requestId,
      workflowId,
      workflowType: SUPERVISOR_MESSAGE_WORKFLOW_TYPE,
    });
    if (started.created) {
      await this.#deliver(workflowId, `${requestId}:delivery`);
    }
    return {
      created: started.created,
      projection: await this.status(workflowId),
      workflowId,
    };
  }

  async retryDue(
    workflowId: string,
    requestId: string
  ): Promise<SupervisorMessageProjection> {
    await this.#workflows.signal({
      name: "retry_due",
      payload: {},
      requestId,
      workflowId,
    });
    await this.#deliver(workflowId, `${requestId}:delivery`);
    return this.status(workflowId);
  }

  async tick(
    workflowId: string,
    requestId: string
  ): Promise<SupervisorMessageProjection> {
    const receipt = await this.#workflows.signal({
      name: "clock_tick",
      payload: {},
      requestId,
      workflowId,
    });
    if (
      receipt.result &&
      typeof receipt.result === "object" &&
      !Array.isArray(receipt.result) &&
      receipt.result.action === "deliver"
    ) {
      await this.#deliver(workflowId, `${requestId}:delivery`);
    }
    return this.status(workflowId);
  }

  async claim(
    workflowId: string,
    claimant: string,
    requestId: string
  ): Promise<SupervisorMessageProjection> {
    await this.#workflows.signal({
      name: "claim",
      payload: { claimant },
      requestId,
      workflowId,
    });
    return this.status(workflowId);
  }

  async acknowledge(
    workflowId: string,
    claimant: string,
    requestId: string
  ): Promise<SupervisorMessageProjection> {
    await this.#workflows.signal({
      name: "acknowledge",
      payload: { claimant },
      requestId,
      workflowId,
    });
    return this.status(workflowId);
  }

  async cancel(
    workflowId: string,
    reason: string,
    requestId: string
  ): Promise<SupervisorMessageProjection> {
    await this.#workflows.cancel({ reason, requestId, workflowId });
    return this.status(workflowId);
  }

  async status(workflowId: string): Promise<SupervisorMessageProjection> {
    const result = await this.#workflows.query({
      name: "status",
      workflowId,
    });
    return asProjection(result.value);
  }

  async #deliver(workflowId: string, requestId: string): Promise<void> {
    const deliveryQuery = await this.#workflows.query({
      args: { workflowId },
      name: "delivery_request",
      workflowId,
    });
    let outcome: SupervisorMessageDeliveryOutcome;
    try {
      outcome = await this.#delivery.deliver(
        asDeliveryRequest(deliveryQuery.value)
      );
    } catch (error) {
      outcome = {
        reason: error instanceof Error ? error.message : "delivery threw",
        status: "transient-failure",
      };
    }
    const payload: JsonObject =
      outcome.status === "accepted"
        ? {}
        : {
            permanent: outcome.status === "permanent-failure",
            reason: outcome.reason,
          };
    await this.#workflows.signal({
      name:
        outcome.status === "accepted"
          ? "delivery_succeeded"
          : "delivery_failed",
      payload,
      requestId,
      workflowId,
    });
  }
}
