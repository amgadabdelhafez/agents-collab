import type { SupervisorMessageAction } from "./supervisor-message-read-model";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";
import type {
  JsonlSupervisorThreadStore,
  SupervisorThreadMessageKind,
} from "./supervisor-thread-store";

export interface SupervisorThreadArtifactBacklink {
  actionRequired: SupervisorMessageAction;
  from: string;
  messageId: string;
  messageKind: SupervisorThreadMessageKind;
  phase: SupervisorMessagePhase;
  receivedAt: string;
  threadId: string;
  to: string;
  workflowId: string;
}

export interface SupervisorThreadArtifactEntry {
  artifactRef: string;
  backlinks: SupervisorThreadArtifactBacklink[];
  referenceCount: number;
  schema: "supervisor-thread-artifact.v1";
}

export interface SupervisorThreadArtifactProjection {
  artifacts: SupervisorThreadArtifactEntry[];
  schema: "supervisor-thread-artifacts.v1";
  sourceRevision: number;
}

const compareBacklinks = (
  left: SupervisorThreadArtifactBacklink,
  right: SupervisorThreadArtifactBacklink
): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  left.workflowId.localeCompare(right.workflowId);

export const readSupervisorThreadArtifacts = (
  store: JsonlSupervisorThreadStore
): SupervisorThreadArtifactProjection => {
  const board = store.read();
  const grouped = new Map<string, SupervisorThreadArtifactBacklink[]>();
  for (const thread of board.threads) {
    for (const message of thread.messages) {
      const backlink: SupervisorThreadArtifactBacklink = {
        actionRequired: message.item.actionRequired,
        from: message.item.from,
        messageId: message.item.messageId,
        messageKind: message.messageKind,
        phase: message.item.phase,
        receivedAt: message.item.receivedAt,
        threadId: message.item.threadId,
        to: message.item.to,
        workflowId: message.item.workflowId,
      };
      for (const artifactRef of message.item.artifactRefs) {
        const current = grouped.get(artifactRef) ?? [];
        current.push({ ...backlink });
        grouped.set(artifactRef, current);
      }
    }
  }
  return {
    artifacts: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([artifactRef, backlinks]) => ({
        artifactRef,
        backlinks: backlinks.sort(compareBacklinks),
        referenceCount: backlinks.length,
        schema: "supervisor-thread-artifact.v1" as const,
      })),
    schema: "supervisor-thread-artifacts.v1",
    sourceRevision: board.revision,
  };
};
