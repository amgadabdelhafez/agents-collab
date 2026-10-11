import type { AgentCard } from "@a2a-js/sdk";
import type { TaskStore } from "@a2a-js/sdk/server";
import { agentCardFor } from "./a2a-supervisor-adapter";
import { SupervisorA2AExecutor } from "./a2a-supervisor-executor";
import { SupervisorA2ARequestHandler } from "./a2a-supervisor-request-handler";
import {
  SupervisorA2AV2Adapter,
  type SupervisorA2AV2AdapterOptions,
} from "./a2a-supervisor-v2-adapter";
import type {
  SupervisorMessageV2DeliveryLedger,
  SupervisorMessageV2DeliveryPort,
  SupervisorMessageV2DeliveryReadinessPort,
  SupervisorMessageV2NotEnrolledDeferral,
  SupervisorMessageV2ReadinessOutageTracker,
} from "./supervisor-message-v2-runtime";
import {
  SupervisorMessageV2Coordinator,
  SupervisorMessageV2DeliveryAttempts,
  SupervisorMessageV2RecoveryRunner,
} from "./supervisor-message-v2-runtime";
import type { SupervisorMessagePolicy } from "./supervisor-message-workflow";
import type { WorkflowPort } from "./workflow-port";

/** How long closing waits for in-flight first delivery attempts. */
const INGRESS_CLOSE_DRAIN_MS = 10_000;

/**
 * The owned V2 ingress composition. It intentionally does not create a
 * listener: a control-plane host owns the authenticated route and supplies
 * the maintained SDK HTTP adapter. Starting this composition performs the
 * durable recovery sweep before that host exposes the route; closing it stops
 * recovery without closing caller-owned TaskStore, Temporal, or listener.
 */
export interface SupervisorA2AV2IngressOptions {
  /**
   * First delivery attempts started after a send's answer. Every ingress of
   * one service shares them, so the service drains them before it closes the
   * stores; omitted, this ingress keeps its own.
   */
  attempts?: SupervisorMessageV2DeliveryAttempts;
  card: Omit<Parameters<typeof agentCardFor>[0], "url"> & { url: string };
  delivery: SupervisorMessageV2DeliveryPort;
  dispatchOwner: string;
  ledger: SupervisorMessageV2DeliveryLedger;
  /** Recovery failure sink; omitted, the runner's stderr logger is used. */
  log?: (message: string) => void;
  /**
   * Shared not-enrolled deferral bound, log, and counters. Omitted, no
   * recipient is ever treated as not enrolled on this ingress.
   */
  notEnrolled?: SupervisorMessageV2NotEnrolledDeferral;
  now: () => string;
  /**
   * RA2: told of each message this ingress durably accepted (its V2 start
   * intent recorded), with the configured recipient. It must not throw.
   */
  onAccepted?: SupervisorA2AV2AdapterOptions["onAccepted"];
  /** The host's config file, for the quarantine commands recovery prints. */
  operatorConfigPath?: string;
  policy: SupervisorMessagePolicy;
  /**
   * Shared readiness-outage bound, log, and counters. Every coordinator of
   * one service shares it; omitted, this ingress keeps its own default.
   */
  readinessOutage?: SupervisorMessageV2ReadinessOutageTracker;
  recoveryIntervalMs?: number;
  sessionReadiness: SupervisorMessageV2DeliveryReadinessPort;
  supervisorId: string;
  taskStore: TaskStore;
  workflows: WorkflowPort;
}

/**
 * A control-plane host may own only this lifecycle. It must not reach into the
 * handler, TaskStore, provider, or listener that remain with the ingress
 * owner.
 */
export interface SupervisorA2AV2IngressLifecycle {
  close(): Promise<void>;
  start(): Promise<void>;
}

export class SupervisorA2AV2Ingress implements SupervisorA2AV2IngressLifecycle {
  readonly card: AgentCard;
  readonly handler: SupervisorA2ARequestHandler;
  readonly #recovery: SupervisorMessageV2RecoveryRunner;
  readonly #attempts: SupervisorMessageV2DeliveryAttempts;
  #closed = false;
  #started: Promise<void> | undefined;

  constructor(options: SupervisorA2AV2IngressOptions) {
    if (
      !options.sessionReadiness ||
      typeof options.sessionReadiness.assertReady !== "function"
    ) {
      throw new Error("Supervisor A2A V2 ingress requires session readiness");
    }
    this.card = agentCardFor(options.card);
    this.#attempts =
      options.attempts ?? new SupervisorMessageV2DeliveryAttempts();
    // A live V2 ingress can only be constructed with the common control-plane
    // readiness boundary. This prevents a caller from exposing a V2 route that
    // silently bypasses current-session verification.
    const coordinator = new SupervisorMessageV2Coordinator(
      options.workflows,
      options.delivery,
      options.ledger,
      options.dispatchOwner,
      () => new Date(options.now()),
      options.sessionReadiness,
      options.readinessOutage,
      options.notEnrolled,
      { attempts: this.#attempts, log: options.log }
    );
    this.handler = new SupervisorA2ARequestHandler(
      this.card,
      options.taskStore,
      new SupervisorA2AExecutor({
        adapter: new SupervisorA2AV2Adapter({
          coordinator,
          now: options.now,
          ...(options.onAccepted ? { onAccepted: options.onAccepted } : {}),
          policy: options.policy,
          supervisorId: options.supervisorId,
        }),
        now: options.now,
      })
    );
    this.#recovery = new SupervisorMessageV2RecoveryRunner({
      coordinator,
      intervalMs: options.recoveryIntervalMs ?? 30_000,
      log: options.log,
      operatorConfigPath: options.operatorConfigPath,
    });
  }

  async start(): Promise<void> {
    if (this.#closed) {
      throw new Error("Supervisor A2A V2 ingress is closed");
    }
    if (!this.#started) {
      this.#started = this.#recovery.start();
    }
    await this.#started;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#started?.catch(() => undefined);
    await this.#recovery.close();
    // Let a first delivery attempt started after a send's answer finish
    // before the caller closes the stores under it, within a bound: one
    // still unfinished is the next start's recovery sweep's to converge.
    await this.#attempts.settle(INGRESS_CLOSE_DRAIN_MS);
  }
}
