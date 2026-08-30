import type { SupervisorMessageBoardItem } from "./supervisor-message-read-model";
import type {
  JsonlSupervisorThreadStore,
  SupervisorThreadMessageKind,
} from "./supervisor-thread-store";

export type SupervisorAttentionMessageKind = Exclude<
  SupervisorThreadMessageKind,
  "informational"
>;

export type SupervisorThreadAttentionItem = Omit<
  SupervisorMessageBoardItem,
  "schema"
> & {
  messageKind: SupervisorAttentionMessageKind;
  schema: "supervisor-thread-attention-item.v1";
};

export interface SupervisorThreadAttentionProjection {
  items: SupervisorThreadAttentionItem[];
  schema: "supervisor-thread-attention.v1";
  sourceRevision: number;
}

const isAttentionKind = (
  value: SupervisorThreadMessageKind
): value is SupervisorAttentionMessageKind => value !== "informational";

const compareItems = (
  left: SupervisorThreadAttentionItem,
  right: SupervisorThreadAttentionItem
): number =>
  right.receivedAt.localeCompare(left.receivedAt) ||
  left.workflowId.localeCompare(right.workflowId);

export const readSupervisorThreadAttention = (
  store: JsonlSupervisorThreadStore
): SupervisorThreadAttentionProjection => {
  const board = store.read();
  const items = board.threads
    .flatMap((thread) => thread.messages)
    .filter((message) => isAttentionKind(message.messageKind))
    .map(
      (message): SupervisorThreadAttentionItem => ({
        ...message.item,
        artifactRefs: [...message.item.artifactRefs],
        messageKind: message.messageKind as SupervisorAttentionMessageKind,
        schema: "supervisor-thread-attention-item.v1",
      })
    )
    .sort(compareItems);
  return {
    items,
    schema: "supervisor-thread-attention.v1",
    sourceRevision: board.revision,
  };
};
