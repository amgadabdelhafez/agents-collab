import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  parseSupervisorMessageBoardItem,
  type SupervisorMessageBoardItem,
} from "./supervisor-message-read-model";

export type SupervisorThreadMessageKind =
  | "authority-decision"
  | "conflict"
  | "failure"
  | "informational"
  | "question";

export interface SupervisorThreadAppendRequest {
  item: SupervisorMessageBoardItem;
  messageKind: SupervisorThreadMessageKind;
  observedAt: string;
  requestId: string;
}

export interface SupervisorThreadAppendReceipt {
  replayed: boolean;
  revision: number;
  schema: "supervisor-thread-append-receipt.v1";
}

export interface SupervisorThreadMessage {
  item: SupervisorMessageBoardItem;
  messageKind: SupervisorThreadMessageKind;
  observedAt: string;
  schema: "supervisor-thread-message.v1";
}

export interface SupervisorThreadProjection {
  messages: SupervisorThreadMessage[];
  participants: string[];
  schema: "supervisor-thread.v1";
  threadId: string;
  updatedAt: string;
}

export interface SupervisorThreadBoardProjection {
  revision: number;
  schema: "supervisor-thread-board.v1";
  threads: SupervisorThreadProjection[];
}

export class SupervisorThreadStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorThreadStoreError";
  }
}

interface SupervisorThreadEvent {
  item: SupervisorMessageBoardItem;
  messageKind: SupervisorThreadMessageKind;
  observedAt: string;
  requestId: string;
  schema: "supervisor-thread-event.v1";
}

const EVENT_KEYS = [
  "item",
  "messageKind",
  "observedAt",
  "requestId",
  "schema",
] as const;
const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MESSAGE_KIND_RE =
  /^(authority-decision|conflict|failure|informational|question)$/;
const REQUEST_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const MAX_EVENT_BYTES = 128 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedValue: readonly string[]
): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...expectedValue].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

const requireString = (
  value: unknown,
  field: string,
  pattern: RegExp
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new SupervisorThreadStoreError(`${field} is invalid`);
  }
  return value;
};

const requireInstant = (value: unknown, field: string): string => {
  const instant = requireString(value, field, CANONICAL_UTC_RE);
  const timestamp = Date.parse(instant);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== instant
  ) {
    throw new SupervisorThreadStoreError(`${field} is invalid`);
  }
  return instant;
};

const parseEvent = (value: unknown): SupervisorThreadEvent => {
  if (!(isRecord(value) && hasExactKeys(value, EVENT_KEYS))) {
    throw new SupervisorThreadStoreError(
      "thread event fields do not match the canonical schema"
    );
  }
  if (value.schema !== "supervisor-thread-event.v1") {
    throw new SupervisorThreadStoreError("thread event schema is invalid");
  }
  return {
    item: parseSupervisorMessageBoardItem(value.item),
    messageKind: requireString(
      value.messageKind,
      "messageKind",
      MESSAGE_KIND_RE
    ) as SupervisorThreadMessageKind,
    observedAt: requireInstant(value.observedAt, "observedAt"),
    requestId: requireString(value.requestId, "requestId", REQUEST_ID_RE),
    schema: "supervisor-thread-event.v1",
  };
};

const cloneItem = (
  item: SupervisorMessageBoardItem
): SupervisorMessageBoardItem => ({
  ...item,
  artifactRefs: [...item.artifactRefs],
});

const sameImmutableMessage = (
  left: SupervisorThreadEvent,
  right: SupervisorThreadEvent
): boolean =>
  left.messageKind === right.messageKind &&
  left.item.messageId === right.item.messageId &&
  left.item.threadId === right.item.threadId &&
  left.item.from === right.item.from &&
  left.item.to === right.item.to &&
  left.item.receivedAt === right.item.receivedAt &&
  JSON.stringify(left.item.artifactRefs) ===
    JSON.stringify(right.item.artifactRefs);

const readJournal = (journalFile: string): SupervisorThreadEvent[] => {
  if (!existsSync(journalFile)) {
    return [];
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      journalFile,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new SupervisorThreadStoreError("thread journal is not a file");
    }
    const content = readFileSync(descriptor, "utf8");
    if (content === "") {
      return [];
    }
    const lines = content.split("\n");
    if (lines.at(-1) !== "") {
      throw new SupervisorThreadStoreError("thread journal is truncated");
    }
    lines.pop();
    const events = lines.map((line, index) => {
      if (!line) {
        throw new SupervisorThreadStoreError(
          `thread journal row ${index + 1} is empty`
        );
      }
      try {
        return parseEvent(JSON.parse(line));
      } catch (error) {
        if (error instanceof SupervisorThreadStoreError) {
          throw error;
        }
        throw new SupervisorThreadStoreError(
          `thread journal row ${index + 1} is malformed`
        );
      }
    });
    const requestIds = events.map((event) => event.requestId);
    if (new Set(requestIds).size !== requestIds.length) {
      throw new SupervisorThreadStoreError(
        "thread journal contains duplicate request IDs"
      );
    }
    return events;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

const appendEvent = (
  journalFile: string,
  event: SupervisorThreadEvent
): void => {
  const line = `${JSON.stringify(event)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    throw new SupervisorThreadStoreError("thread event exceeds byte limit");
  }
  mkdirSync(dirname(journalFile), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      journalFile,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags require bitwise composition.
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new SupervisorThreadStoreError("thread journal is not a file");
    }
    const written = writeSync(descriptor, line, undefined, "utf8");
    if (written !== bytes) {
      throw new SupervisorThreadStoreError("thread event append was partial");
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
};

const projectThreads = (
  events: readonly SupervisorThreadEvent[]
): SupervisorThreadBoardProjection => {
  const latestByWorkflow = new Map<string, SupervisorThreadEvent>();
  for (const event of events) {
    const previous = latestByWorkflow.get(event.item.workflowId);
    if (previous && !sameImmutableMessage(previous, event)) {
      throw new SupervisorThreadStoreError(
        `workflow ${event.item.workflowId} changed immutable thread identity`
      );
    }
    latestByWorkflow.set(event.item.workflowId, event);
  }
  const grouped = new Map<string, SupervisorThreadEvent[]>();
  for (const event of latestByWorkflow.values()) {
    const current = grouped.get(event.item.threadId) ?? [];
    current.push(event);
    grouped.set(event.item.threadId, current);
  }
  const threads = [...grouped.entries()].map(([threadId, threadEvents]) => {
    const messages = threadEvents
      .sort(
        (left, right) =>
          left.item.receivedAt.localeCompare(right.item.receivedAt) ||
          left.item.workflowId.localeCompare(right.item.workflowId)
      )
      .map(
        (event): SupervisorThreadMessage => ({
          item: cloneItem(event.item),
          messageKind: event.messageKind,
          observedAt: event.observedAt,
          schema: "supervisor-thread-message.v1",
        })
      );
    const participants = [
      ...new Set(messages.flatMap(({ item }) => [item.from, item.to])),
    ].sort();
    const updatedAt = messages.reduce(
      (latest, message) =>
        message.observedAt > latest ? message.observedAt : latest,
      messages[0]?.observedAt ?? ""
    );
    return {
      messages,
      participants,
      schema: "supervisor-thread.v1" as const,
      threadId,
      updatedAt,
    };
  });
  threads.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.threadId.localeCompare(right.threadId)
  );
  return {
    revision: events.length,
    schema: "supervisor-thread-board.v1",
    threads,
  };
};

export class JsonlSupervisorThreadStore {
  readonly #journalFile: string;

  constructor(journalFile: string) {
    this.#journalFile = journalFile;
  }

  append(
    requestValue: SupervisorThreadAppendRequest
  ): SupervisorThreadAppendReceipt {
    const event = parseEvent({
      ...requestValue,
      schema: "supervisor-thread-event.v1",
    });
    const events = readJournal(this.#journalFile);
    const existing = events.find(
      (candidate) => candidate.requestId === event.requestId
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new SupervisorThreadStoreError(
          `request ${event.requestId} conflicts with a durable event`
        );
      }
      return {
        replayed: true,
        revision: events.length,
        schema: "supervisor-thread-append-receipt.v1",
      };
    }
    const previous = [...events]
      .reverse()
      .find((candidate) => candidate.item.workflowId === event.item.workflowId);
    if (previous && !sameImmutableMessage(previous, event)) {
      throw new SupervisorThreadStoreError(
        `workflow ${event.item.workflowId} changed immutable thread identity`
      );
    }
    appendEvent(this.#journalFile, event);
    return {
      replayed: false,
      revision: events.length + 1,
      schema: "supervisor-thread-append-receipt.v1",
    };
  }

  read(): SupervisorThreadBoardProjection {
    return projectThreads(readJournal(this.#journalFile));
  }
}
