import { type DeliveryResult, dispatchBridgeMessage } from "./bridge-dispatch";
import type { BridgeTarget } from "./bridge-store";
import type {
  SupervisorMessageDeliveryOutcome,
  SupervisorMessageDeliveryPort,
} from "./supervisor-message-coordinator";
import type { SupervisorMessageDeliveryRequest } from "./supervisor-message-workflow";

export interface SupervisorBridgeRoute {
  runDir: string;
  target: BridgeTarget;
}

export interface SupervisorBridgeDirectory {
  resolve(
    supervisorId: string
  ):
    | Promise<SupervisorBridgeRoute | undefined>
    | SupervisorBridgeRoute
    | undefined;
}

export type SupervisorBridgeDispatch = (
  route: SupervisorBridgeRoute,
  request: SupervisorMessageDeliveryRequest,
  now: string
) => Promise<DeliveryResult>;

export interface BridgeSupervisorMessageDeliveryOptions {
  directory: SupervisorBridgeDirectory;
  dispatch?: SupervisorBridgeDispatch;
  now?: () => string;
}

const defaultDispatch: SupervisorBridgeDispatch = (route, request, now) =>
  dispatchBridgeMessage(
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
      threadId: request.threadId,
      type: "work_request",
    }
  );

export class BridgeSupervisorMessageDeliveryPort
  implements SupervisorMessageDeliveryPort
{
  readonly #directory: SupervisorBridgeDirectory;
  readonly #dispatch: SupervisorBridgeDispatch;
  readonly #now: () => string;

  constructor(options: BridgeSupervisorMessageDeliveryOptions) {
    this.#directory = options.directory;
    this.#dispatch = options.dispatch ?? defaultDispatch;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async deliver(
    request: SupervisorMessageDeliveryRequest
  ): Promise<SupervisorMessageDeliveryOutcome> {
    const route = await this.#directory.resolve(request.target);
    if (!route) {
      return {
        reason: `no trusted bridge route for ${request.target}`,
        status: "transient-failure",
      };
    }
    try {
      const result = await this.#dispatch(route, request, this.#now());
      switch (result.status) {
        case "accepted":
        case "delivered":
        case "duplicate":
        case "queued":
          return { status: "accepted" };
        case "dead-letter":
        case "expired":
          return {
            reason: result.reason ?? `bridge ${result.status}`,
            status: "permanent-failure",
          };
        default:
          return {
            reason: "unsupported bridge delivery status",
            status: "transient-failure",
          };
      }
    } catch (error) {
      return {
        reason:
          error instanceof Error ? error.message : "bridge delivery threw",
        status: "transient-failure",
      };
    }
  }
}
