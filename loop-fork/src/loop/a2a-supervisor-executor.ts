import { type Message, type Task, TaskState } from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import type { SupervisorA2AAdapter } from "./a2a-supervisor-adapter";

/**
 * The maintained SDK executor needs only the bounded ingress translation
 * surface. Keeping this structural prevents the SDK-facing executor from
 * selecting either the legacy V1 or tenant-aware V2 coordinator itself.
 */
type SupervisorA2AIngressAdapter = Pick<SupervisorA2AAdapter, "sendMessage">;

/**
 * Stage 2: the adapter presented as the SDK's own `AgentExecutor`, so a real
 * A2A server can drive it. Still no network and no live activation.
 *
 * This implements the SDK's `AgentExecutor` against the SDK's own
 * `RequestContext`, `ExecutionEventBus` and `AgentEvent` — not local
 * lookalikes. Review flagged (2026-09-20) that the previous version declared
 * its own request and bus interfaces and cast its result with `as Task`, which
 * meant "a real server can drive this" was structurally plausible rather than
 * demonstrated. The cast is gone: the task is built as a `Task` and rejected by
 * the compiler if it is not one, and `tests/loop/a2a-sdk-round-trip.test.ts`
 * drives this class through the SDK's own `DefaultRequestHandler`.
 *
 * ## The identity conflict, which is a finding rather than a detail
 *
 * A2A task ids are ASSIGNED BY THE SERVER: `RequestContext.taskId` arrives
 * already chosen, per request. Our workflow id is DERIVED from the message
 * (sha256 of the dedupe key), so the same message id always names the same
 * work. These are different identity models, and the difference is not
 * cosmetic:
 *
 *   a resend that A2A treats as a NEW task is still, for us, the SAME workflow.
 *
 * So the protocol's task id cannot stand in for the workflow id, and this
 * executor does not pretend otherwise. It reports the server's task id as the
 * task id, because that is what the caller asked about, and carries the
 * workflow id alongside it in task metadata under `WORKFLOW_ID_METADATA_KEY`.
 * Both are visible, neither is silently substituted for the other.
 *
 * The consequence for the migration plan: A2A task identity is NOT a
 * replacement for content-addressed deduplication, so stage 2 cannot retire the
 * dedupe key on the grounds that "A2A has ids". It has ids for a different
 * question. See a2a-reuse-assessment.md.
 */
export const WORKFLOW_ID_METADATA_KEY = "harness.dev/workflowId";
/**
 * Every workflow this A2A task has spawned, oldest first.
 *
 * One A2A task can carry several turns, and each turn routes its own supervisor
 * message, so the mapping from task to workflow is one-to-many. An earlier
 * version wrote only the current turn's id, which made the task store
 * last-write-wins: after a follow-up turn the first turn's workflow was
 * unreachable through the protocol even though its work was still live. The
 * singular key above still names THIS turn, because that is what a caller
 * usually wants; this one preserves the whole chain so nothing is orphaned.
 */
export const WORKFLOW_IDS_METADATA_KEY = "harness.dev/workflowIds";
export const TASK_STATE_METADATA_KEY = "harness.dev/messagePhase";
/**
 * An opaque, deterministic correlation value for the trusted tenant and
 * authenticated caller that owns this task. It permits scoped diagnostics
 * without placing raw tenant or principal values in the protocol task or the
 * body-free board projection.
 */
export const SCOPE_ID_METADATA_KEY = "harness.dev/scopeId";

/**
 * Refuses an unauthenticated caller outright.
 *
 * The principal is taken from the AUTHENTICATED CALLER on the server call
 * context, never from the message. A2A's Message metadata says who a sender
 * CLAIMS to be; `context.user` is who the transport actually authenticated.
 * Those are different facts and only the second may be handed to governance.
 * The SDK supplies an `UnauthenticatedUser` when nothing authenticated the
 * request, and routing that under some default principal would hand governance
 * a caller nobody identified.
 */
const callerScopeOf = (
  context: RequestContext["context"]
): { principal: string; tenant: string } => {
  const user = context.user;
  if (!user?.isAuthenticated) {
    throw new Error(
      "an A2A request to a supervisor must be authenticated: no principal to submit to governance"
    );
  }
  if (!context.tenant?.trim()) {
    throw new Error(
      "an A2A request to a supervisor needs a transport-bound tenant before it can reach governance"
    );
  }
  return { principal: user.userName, tenant: context.tenant };
};

export interface SupervisorA2AExecutorOptions {
  adapter: SupervisorA2AIngressAdapter;
  now: () => string;
}

/**
 * Builds the task. Declared as `Task` with no cast, so a field the protocol
 * requires and this function forgets is a compile error rather than something
 * a peer discovers.
 */
/**
 * Carries forward what an existing task already holds, so a follow-up turn adds
 * to the record rather than replacing it.
 *
 * History is carried but the incoming message is NOT appended here: the SDK's
 * result manager appends it to whatever history the published task carries.
 * Observed directly — adding it here too produced ["m1", "m2", "m2"] after two
 * turns. So this returns the PRIOR history and lets the SDK add the new turn,
 * which is the one place it can be done exactly once.
 */
const carryForward = (
  previous: Task | undefined,
  workflowId?: string
): { history: Message[]; workflowIds: string[] } => {
  const priorIds = previous?.metadata?.[WORKFLOW_IDS_METADATA_KEY];
  const workflowIds = Array.isArray(priorIds)
    ? priorIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    history: previous?.history ?? [],
    workflowIds: workflowId ? [...workflowIds, workflowId] : workflowIds,
  };
};

const taskOf = (input: {
  at: string;
  contextId: string;
  history: Message[];
  metadata: { [key: string]: unknown };
  state: TaskState;
  taskId: string;
}): Task => ({
  artifacts: [],
  contextId: input.contextId,
  history: input.history,
  id: input.taskId,
  metadata: input.metadata,
  status: { message: undefined, state: input.state, timestamp: input.at },
});

export class SupervisorA2AExecutor implements AgentExecutor {
  readonly #adapter: SupervisorA2AIngressAdapter;
  readonly #now: () => string;

  constructor(options: SupervisorA2AExecutorOptions) {
    this.#adapter = options.adapter;
    this.#now = options.now;
  }

  /**
   * Routes the request through the governed runtime and publishes the outcome
   * as a task.
   *
   * A refusal — an unauthenticated caller, an unsupported part, a missing
   * sender, a principal with no grant — is published as a FAILED task rather
   * than thrown, because the caller is a transport that has to answer its own
   * client, and an exception escaping here would leave the bus open with
   * nothing on it. The reason is carried in metadata; the refusal itself
   * already happened before any durable write, in the adapter.
   *
   * Worth a reviewer's attention: a governance DENIAL and a malformed request
   * both surface here as FAILED, distinguishable only by the metadata reason.
   * If denials need to be separable at the protocol level, that is a change to
   * make deliberately rather than something to infer from this shape.
   */
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> {
    const at = this.#now();
    const userMessage = requestContext.userMessage;
    try {
      const caller = callerScopeOf(requestContext.context);
      const routed = await this.#adapter.sendMessage({
        message: userMessage,
        principal: caller.principal,
        tenant: caller.tenant,
      });
      const carried = carryForward(requestContext.task, routed.taskId);
      eventBus.publish(
        AgentEvent.task(
          taskOf({
            at,
            contextId: requestContext.contextId,
            history: carried.history,
            // The SERVER's task id, with our workflow ids carried beside it.
            // See the identity note above: neither replaces the other.
            metadata: {
              [SCOPE_ID_METADATA_KEY]: routed.scopeId,
              [WORKFLOW_ID_METADATA_KEY]: routed.taskId,
              [WORKFLOW_IDS_METADATA_KEY]: carried.workflowIds,
            },
            state: routed.state,
            taskId: requestContext.taskId,
          })
        )
      );
    } catch (error) {
      // A refused turn started no workflow, so it adds nothing to the chain,
      // but it must not erase what earlier turns recorded.
      const carried = carryForward(requestContext.task);
      eventBus.publish(
        AgentEvent.task(
          taskOf({
            at,
            contextId: requestContext.contextId,
            history: carried.history,
            metadata: {
              [TASK_STATE_METADATA_KEY]:
                error instanceof Error ? error.message : "refused",
              [WORKFLOW_IDS_METADATA_KEY]: carried.workflowIds,
            },
            state: TaskState.TASK_STATE_FAILED,
            taskId: requestContext.taskId,
          })
        )
      );
    } finally {
      eventBus.finished();
    }
  }

  /**
   * Cancellation is NOT implemented, and says so rather than reporting a
   * cancellation it did not perform.
   *
   * Cancelling a supervisor message is a governed operation: the sender's
   * principal holds the `cancel` grant, and this executor is not given a
   * principal on this path — the SDK's signature passes only a task id. A
   * cancel accepted here would either bypass governance or silently do
   * nothing, and publishing CANCELED for work still live in the workflow is the
   * same class of lie as projecting WORKING from a receipt.
   */
  cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    return Promise.reject(
      new Error(
        `cancelling ${taskId} over A2A is not implemented: cancel is a governed operation and this path carries no principal`
      )
    );
  }
}
