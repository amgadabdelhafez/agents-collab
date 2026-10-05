import type { SupervisorMessageBoardItem } from "./supervisor-message-read-model";

/**
 * Nothing in the service advanced a message's own deadlines: a delivery that
 * failed transiently sat in "retry-scheduled" until some client happened to
 * send a tick, and an undelivered message never escalated. Three supervisor
 * messages sat that way for 13 days (2026-09-06 to 2026-09-19).
 *
 * This is the one owner of those deadlines. It ticks each open message on an
 * interval; the workflow itself decides whether a retry is due, whether the
 * claim deadline passed, or whether nothing changes. It creates no per-project
 * timer and no second scheduler.
 */
export type DeadlineTick = (input: {
  principal: string;
  requestId: string;
  workflowId: string;
}) => Promise<unknown>;

export interface SupervisorDeadlineDriverOptions {
  board: () => readonly SupervisorMessageBoardItem[];
  log?: (line: string) => void;
  now?: () => string;
  /**
   * The principal authorized to tick THIS message, which is a property of the
   * message and not of the driver: in the grants of record, `tick` belongs to
   * the recipient's principal, so no single principal can drive a whole estate.
   * Returning undefined means nobody is authorized; the message is then left
   * alone and reported, never ticked under a borrowed identity.
   */
  principalFor: (item: SupervisorMessageBoardItem) => string | undefined;
  tick: DeadlineTick;
}

// Phases whose deadlines are still the service's to drive.
const OPEN_PHASES = new Set([
  "received",
  "routed",
  "retry-scheduled",
  "escalated",
  "claimed",
]);

export interface DeadlineSweepResult {
  failed: number;
  ticked: string[];
  // Open messages nobody is authorized to tick. Reported, never silently
  // skipped: an unauthorized deadline is a configuration defect, not a no-op.
  unauthorized: string[];
}

export class SupervisorDeadlineDriver {
  readonly #board: () => readonly SupervisorMessageBoardItem[];
  readonly #log: (line: string) => void;
  readonly #now: () => string;
  readonly #principalFor: (
    item: SupervisorMessageBoardItem
  ) => string | undefined;
  readonly #tick: DeadlineTick;
  #sweeps = 0;

  constructor(options: SupervisorDeadlineDriverOptions) {
    this.#board = options.board;
    this.#log = options.log ?? (() => undefined);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#principalFor = options.principalFor;
    this.#tick = options.tick;
  }

  async sweep(): Promise<DeadlineSweepResult> {
    this.#sweeps += 1;
    const at = this.#now();
    const result: DeadlineSweepResult = {
      failed: 0,
      ticked: [],
      unauthorized: [],
    };
    for (const item of this.#board()) {
      if (!OPEN_PHASES.has(item.phase)) {
        continue;
      }
      const principal = this.#principalFor(item);
      if (!principal) {
        result.unauthorized.push(item.workflowId);
        this.#log(
          `[loop] no principal is authorized to tick ${item.workflowId} (${item.from} -> ${item.to})`
        );
        continue;
      }
      try {
        // The requestId is derived, so a repeated sweep of the same message at
        // the same instant is the same request, never a second effect.
        await this.#tick({
          principal,
          requestId: `deadline:${item.workflowId}:${at}`,
          workflowId: item.workflowId,
        });
        result.ticked.push(item.workflowId);
      } catch (error) {
        result.failed += 1;
        this.#log(
          `[loop] deadline tick failed for ${item.workflowId}: ${error instanceof Error ? error.message : "unknown error"}`
        );
      }
    }
    return result;
  }

  get sweeps(): number {
    return this.#sweeps;
  }
}
