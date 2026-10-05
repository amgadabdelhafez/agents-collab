import type { TrustedSupervisorMessageV2Scope } from "./supervisor-message-v2-contract";
import { supervisorMessageV2ScopedDigest } from "./supervisor-message-v2-workflow-identity";
import type {
  PostgresSupervisorSessionV2Store,
  SupervisorSessionDescriptorStatusV2,
} from "./supervisor-session-v2";

/**
 * Read-only bridge from current-session control state to a task-graph host.
 * It intentionally does not call `satisfyGate`: the graph owner must bind an
 * approved graph/task/gate and write its own normal Temporal receipt. This
 * adapter only supplies a scoped, body-free dependency status.
 */
export interface SupervisorSessionV2DagGateStatus {
  descriptor: SupervisorSessionDescriptorStatusV2 | undefined;
  gateId: string;
  ready: boolean;
  schema: "supervisor-session-dag-gate-status.v2";
}

/** A host-visible, passive query capability. It has no graph mutation method. */
export interface SupervisorSessionV2DagGateQuery {
  status(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionV2DagGateStatus>;
}

export class SupervisorSessionV2DagAdapter
  implements SupervisorSessionV2DagGateQuery
{
  readonly #sessions: Pick<PostgresSupervisorSessionV2Store, "status">;

  constructor(sessions: Pick<PostgresSupervisorSessionV2Store, "status">) {
    this.#sessions = sessions;
  }

  async status(
    trustedScope: TrustedSupervisorMessageV2Scope,
    recipient: string
  ): Promise<SupervisorSessionV2DagGateStatus> {
    const descriptor = await this.#sessions.status(trustedScope, recipient);
    return {
      descriptor,
      gateId: `session-ready:v2:${supervisorMessageV2ScopedDigest(
        trustedScope.tenantId,
        trustedScope.principal,
        "task-graph-session-gate",
        [recipient]
      )}`,
      ready: descriptor?.ready === true,
      schema: "supervisor-session-dag-gate-status.v2",
    };
  }
}
