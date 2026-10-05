import { Artifact, type Task, TaskState } from "@a2a-js/sdk";
import type { ServerCallContext, TaskStore } from "@a2a-js/sdk/server";
import { WORKFLOW_IDS_METADATA_KEY } from "./a2a-supervisor-executor";
import type { WorkflowPort } from "./workflow-port";

/** Host-owned binding, never copied from recipient JSON. Temporal task graph
 * owns acceptance; A2A TaskStore is the durable protocol projection of it.
 */
export interface SupervisorA2AResultBinding {
  a2aTaskId: string;
  graphTaskId: string;
  graphWorkflowId: string;
  messageWorkflowId: string;
  recipient: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const artifactReference = /^artifact:\/\/sha256\/[a-f0-9]{64}$/;
const artifactSemantics = (artifact: Artifact): string =>
  JSON.stringify(Artifact.toJSON(artifact), (_key, value) =>
    record(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        )
      : value
  );

export const publishSupervisorA2AAcceptedResult = async (input: {
  binding: SupervisorA2AResultBinding;
  /** Authenticated original sender context, resolved by the host. */
  context: ServerCallContext;
  store: TaskStore;
  workflows: Pick<WorkflowPort, "query">;
  verifyArtifact(reference: string): Promise<boolean>;
  now(): string;
}): Promise<void> => {
  const binding = input.binding;
  const task = await input.store.load(binding.a2aTaskId, input.context);
  if (
    task?.status &&
    [
      TaskState.TASK_STATE_CANCELED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_REJECTED,
    ].includes(task.status.state)
  ) {
    throw new Error(
      "A failed or canceled task cannot accept a successful result"
    );
  }
  if (
    !(
      task &&
      Array.isArray(task.metadata?.[WORKFLOW_IDS_METADATA_KEY]) &&
      task.metadata[WORKFLOW_IDS_METADATA_KEY].includes(
        binding.messageWorkflowId
      )
    )
  ) {
    throw new Error("Result does not belong to this A2A task");
  }
  const result = await input.workflows.query({
    workflowId: binding.graphWorkflowId,
    name: "status",
  });
  const projection = result.value;
  if (
    !record(projection) ||
    projection.schema !== "task-graph-projection.v1" ||
    !Array.isArray(projection.nodes)
  ) {
    throw new Error("Result graph projection is invalid");
  }
  const node = projection.nodes.find(
    (value: unknown) => record(value) && value.taskId === binding.graphTaskId
  );
  if (
    !record(node) ||
    node.phase !== "succeeded" ||
    node.workerId !== binding.recipient ||
    !Array.isArray(node.acceptanceReceipts) ||
    node.acceptanceReceipts.length === 0
  ) {
    throw new Error("Work result is not accepted for this recipient");
  }
  const receipts: { checkId: string; artifactRef: string }[] = [];
  for (const receipt of node.acceptanceReceipts) {
    if (
      !record(receipt) ||
      typeof receipt.checkId !== "string" ||
      typeof receipt.artifactRef !== "string" ||
      !artifactReference.test(receipt.artifactRef) ||
      !(await input.verifyArtifact(receipt.artifactRef))
    ) {
      throw new Error("Result acceptance artifact is unverified");
    }
    receipts.push({
      checkId: receipt.checkId,
      artifactRef: receipt.artifactRef,
    });
  }
  const artifact: Artifact = {
    artifactId: `accepted:${binding.messageWorkflowId}`,
    name: "Accepted work result",
    description:
      "Verified Temporal task-graph acceptance receipts, not a delivery acknowledgement.",
    extensions: [],
    metadata: undefined,
    parts: [
      {
        content: {
          $case: "data",
          value: {
            schema: "supervisor-work-result.v1",
            messageWorkflowId: binding.messageWorkflowId,
            graphWorkflowId: binding.graphWorkflowId,
            graphTaskId: binding.graphTaskId,
            recipient: binding.recipient,
            receipts,
          },
        },
        filename: "",
        mediaType: "application/json",
        metadata: undefined,
      },
    ],
  };
  const transform = (current: Task | undefined): Task => {
    if (
      !current ||
      [
        TaskState.TASK_STATE_CANCELED,
        TaskState.TASK_STATE_FAILED,
        TaskState.TASK_STATE_REJECTED,
      ].includes(current.status?.state ?? 0)
    ) {
      throw new Error("Result task is missing or terminally refused");
    }
    const task = current;
    const prior = task.artifacts.find(
      (value) => value.artifactId === artifact.artifactId
    );
    if (prior && artifactSemantics(prior) !== artifactSemantics(artifact)) {
      throw new Error("Accepted result conflicts with prior artifact");
    }
    const artifacts = prior ? task.artifacts : [...task.artifacts, artifact];
    const workflowIds = task.metadata?.[WORKFLOW_IDS_METADATA_KEY] as string[];
    const allAccepted = workflowIds.every((workflowId) =>
      artifacts.some((value) => value.artifactId === `accepted:${workflowId}`)
    );
    return {
      ...task,
      artifacts,
      status: {
        ...task.status,
        state: allAccepted
          ? TaskState.TASK_STATE_COMPLETED
          : (task.status?.state ?? TaskState.TASK_STATE_SUBMITTED),
        timestamp: prior ? task.status?.timestamp : input.now(),
        message: task.status?.message,
      },
    };
  };
  const store = input.store as TaskStore & {
    update?: (
      id: string,
      context: ServerCallContext,
      transform: (current: Task | undefined) => Task
    ) => Promise<void>;
  };
  if (!store.update) {
    throw new Error(
      "Accepted result publication requires an atomic task store"
    );
  }
  await store.update(binding.a2aTaskId, input.context, transform);
};
