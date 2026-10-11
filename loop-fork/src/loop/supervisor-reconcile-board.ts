import type { SupervisorMessageBoardItem } from "./supervisor-message-read-model";
import type { SupervisorMessagePhase } from "./supervisor-message-workflow";
import type { SupervisorThreadBoardProjection } from "./supervisor-thread-store";

/** The board by workflow id; the first item a workflow id names wins. */
export const indexBoardItems = (
  threads: SupervisorThreadBoardProjection
): ReadonlyMap<string, SupervisorMessageBoardItem> => {
  const index = new Map<string, SupervisorMessageBoardItem>();
  for (const thread of threads.threads) {
    for (const message of thread.messages) {
      if (!index.has(message.item.workflowId)) {
        index.set(message.item.workflowId, message.item);
      }
    }
  }
  return index;
};

/**
 * One board read per reconcile pass, and again only after this pass changed
 * it. Reading the board stats (and, when it changed, parses) the thread
 * journal and clones the projection, so the reconcilers' former read per
 * inspected key, twice or three times over, made every 250 ms pass re-read
 * the live multi-megabyte journal several times.
 */
export class ReconcilePassBoard {
  readonly #read: () => SupervisorThreadBoardProjection;
  #index: ReadonlyMap<string, SupervisorMessageBoardItem> | undefined;
  #reads = 0;

  constructor(read: () => SupervisorThreadBoardProjection) {
    this.#read = read;
  }

  item(workflowId: string): SupervisorMessageBoardItem | undefined {
    if (!this.#index) {
      this.#reads += 1;
      this.#index = indexBoardItems(this.#read());
    }
    return this.#index.get(workflowId);
  }

  phase(workflowId: string): SupervisorMessagePhase | undefined {
    return this.item(workflowId)?.phase;
  }

  /** This pass wrote through the runtime: the next lookup reads again. */
  changed(): void {
    this.#index = undefined;
  }

  /** How many times this pass read the board. */
  get reads(): number {
    return this.#reads;
  }
}
