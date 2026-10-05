import { type DeliveryResult, dispatchBridgeMessage } from "./bridge-dispatch";
import {
  deliverCodexBridgeMessage,
  ensureBridgeWorker,
  hasBridgeDeliveryRoute,
  isBridgeDeliveryClaimed,
} from "./bridge-runtime";
import {
  type BridgeMessage,
  type BridgeTarget,
  readBridgeEvents,
  readBridgeStatus,
  readPendingBridgeMessages,
} from "./bridge-store";
import { probeCodexThread } from "./codex-app-server";
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

export type SupervisorBridgeProviderDelivery = (
  route: SupervisorBridgeRoute,
  entry: BridgeMessage
) => boolean | Promise<boolean>;

export type SupervisorBridgeProviderProbe = (
  route: SupervisorBridgeRoute
) => boolean | Promise<boolean>;

export type SupervisorBridgeRouteReadiness = (
  route: SupervisorBridgeRoute
) => Promise<boolean> | boolean;

export interface BridgeSupervisorMessageDeliveryOptions {
  directory: SupervisorBridgeDirectory;
  dispatch?: SupervisorBridgeDispatch;
  now?: () => string;
  providerDelivery?: SupervisorBridgeProviderDelivery;
  providerProbe?: SupervisorBridgeProviderProbe;
  routeReady?: SupervisorBridgeRouteReadiness;
}

const defaultProviderDelivery: SupervisorBridgeProviderDelivery = (
  route,
  entry
) => deliverCodexBridgeMessage(route.runDir, entry);

const defaultProviderProbe: SupervisorBridgeProviderProbe = (route) => {
  if (route.target !== "codex") {
    return true;
  }
  const status = readBridgeStatus(route.runDir);
  return probeCodexThread(status.codexRemoteUrl, status.codexThreadId);
};

const isLogicalSupervisorDelivery = (
  entry: BridgeMessage,
  route: SupervisorBridgeRoute,
  request: SupervisorMessageDeliveryRequest
): boolean =>
  entry.source === "supervisor" &&
  entry.target === route.target &&
  entry.type === "work_request" &&
  entry.message === request.body &&
  entry.subject === request.messageId &&
  entry.taskId === request.workflowId &&
  entry.threadId === request.threadId;

interface LogicalSupervisorDelivery {
  accepted?: BridgeMessage;
  existing?: BridgeMessage;
}

const logicalSupervisorDelivery = (
  route: SupervisorBridgeRoute,
  request: SupervisorMessageDeliveryRequest
): LogicalSupervisorDelivery => {
  const entries = new Map<string, BridgeMessage>();
  const delivered = new Set<string>();
  for (const event of readBridgeEvents(route.runDir)) {
    if (event.kind === "message") {
      entries.set(event.id, event);
    } else if (event.kind === "delivered") {
      delivered.add(event.id);
    }
  }
  const matching = [...entries.values()].filter((entry) =>
    isLogicalSupervisorDelivery(entry, route, request)
  );
  return {
    accepted: matching.find((entry) => delivered.has(entry.id)),
    existing: matching.at(-1),
  };
};

const acceptedLogicalSupervisorDelivery = (
  route: SupervisorBridgeRoute,
  request: SupervisorMessageDeliveryRequest
): BridgeMessage | undefined =>
  logicalSupervisorDelivery(route, request).accepted;

const logicalDeliveryResult = (
  entry: BridgeMessage,
  status: "delivered" | "duplicate",
  target: BridgeTarget
): DeliveryResult => ({ entry, status, target });

const logicalBridgeDedupeKey = (
  request: SupervisorMessageDeliveryRequest
): string => `supervisor-delivery:${request.workflowId}`;

const retryExistingLogicalSupervisorDelivery = async (
  route: SupervisorBridgeRoute,
  request: SupervisorMessageDeliveryRequest,
  providerDelivery: SupervisorBridgeProviderDelivery
): Promise<DeliveryResult | undefined> => {
  const initial = logicalSupervisorDelivery(route, request);
  if (!initial.existing) {
    return undefined;
  }
  if (initial.accepted) {
    return logicalDeliveryResult(initial.accepted, "delivered", route.target);
  }
  const pending = readPendingBridgeMessages(route.runDir).find(
    (entry) => entry.id === initial.existing?.id
  );
  // The bridge worker and direct provider share this claim. If a worker holds
  // it, leave the one existing logical record in place and let the existing
  // Temporal retry owner observe its durable outcome later.
  if (!pending || isBridgeDeliveryClaimed(route.runDir, initial.existing.id)) {
    const settled = logicalSupervisorDelivery(route, request);
    return logicalDeliveryResult(
      settled.accepted ?? initial.existing,
      settled.accepted ? "delivered" : "duplicate",
      route.target
    );
  }
  const delivered =
    route.target === "codex" && (await providerDelivery(route, pending));
  const settled = logicalSupervisorDelivery(route, request);
  // A competing worker can durably accept the entry after the direct provider
  // attempt begins. Re-read the append-only bridge record so that interleaving
  // becomes acceptance, never a second enqueue.
  return logicalDeliveryResult(
    settled.accepted ?? pending,
    delivered || settled.accepted ? "delivered" : "duplicate",
    route.target
  );
};

const defaultDispatch =
  (
    providerDelivery: SupervisorBridgeProviderDelivery
  ): SupervisorBridgeDispatch =>
  async (route, request, now) => {
    // A transient provider failure leaves one durable pending bridge record.
    // Workflow retry IDs intentionally advance for observability, so use the
    // immutable logical delivery fields to retry that same record rather than
    // appending a second body with the next attempt ID.
    const retried = await retryExistingLogicalSupervisorDelivery(
      route,
      request,
      providerDelivery
    );
    if (retried) {
      return retried;
    }
    return dispatchBridgeMessage(
      route.runDir,
      "supervisor",
      route.target,
      request.body,
      route.target === "codex"
        ? (entry) => providerDelivery(route, entry)
        : undefined,
      undefined,
      {
        artifactRefs: request.artifactRefs,
        dedupeKey: logicalBridgeDedupeKey(request),
        dedupeResolved: true,
        now,
        subject: request.messageId,
        taskId: request.workflowId,
        threadId: request.threadId,
        type: "work_request",
      }
    );
  };

const defaultRouteReady =
  (
    providerProbe: SupervisorBridgeProviderProbe
  ): SupervisorBridgeRouteReadiness =>
  async (route) => {
    if (!hasBridgeDeliveryRoute(route.runDir, route.target)) {
      return false;
    }
    if (!(await providerProbe(route))) {
      return false;
    }
    return ensureBridgeWorker(route.runDir);
  };

export class BridgeSupervisorMessageDeliveryPort
  implements SupervisorMessageDeliveryPort
{
  readonly #directory: SupervisorBridgeDirectory;
  readonly #dispatch: SupervisorBridgeDispatch;
  readonly #now: () => string;
  readonly #routeReady: SupervisorBridgeRouteReadiness;

  constructor(options: BridgeSupervisorMessageDeliveryOptions) {
    this.#directory = options.directory;
    this.#dispatch =
      options.dispatch ??
      defaultDispatch(options.providerDelivery ?? defaultProviderDelivery);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#routeReady =
      options.routeReady ??
      (options.dispatch
        ? () => true
        : defaultRouteReady(options.providerProbe ?? defaultProviderProbe));
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
      // A bridge worker can accept the original record after the workflow has
      // scheduled a retry. Its durable provider-acceptance event is stronger
      // evidence than a later retry attempt, so adopt it without re-enqueueing
      // or re-invoking the provider. This remains distinct from recipient
      // consumption and work completion.
      if (acceptedLogicalSupervisorDelivery(route, request)) {
        return { status: "accepted" };
      }
      if (!(await this.#routeReady(route))) {
        return {
          reason: `bridge route for ${request.target} is unavailable`,
          status: "transient-failure",
        };
      }
      const result = await this.#dispatch(route, request, this.#now());
      switch (result.status) {
        case "accepted":
        case "delivered":
          return { status: "accepted" };
        // A queue append is durable, but neither proves that the provider
        // accepted the turn nor that the recipient read it. A duplicate is a
        // pending matching append, so it carries the same lack of provider
        // acceptance. Keep both retryable under the existing Temporal
        // deadline owner instead of emitting delivery_succeeded.
        case "duplicate":
        case "queued":
          return {
            reason: "bridge queued without provider acceptance",
            status: "transient-failure",
          };
        case "deferred":
          return {
            reason: result.reason ?? "bridge logical delivery is in progress",
            status: "transient-failure",
          };
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
