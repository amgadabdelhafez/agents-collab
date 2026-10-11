import type { A2AClientEndpoint } from "./a2a-session-client";
import {
  A2A_V2_LEASE_EPOCH_HEADER,
  A2A_V2_LEASE_HOLDER_HEADER,
  a2aV2SessionInboxPath,
} from "./a2a-v2-routes-contract";
import type { SupervisorEndpointLeaseFence } from "./supervisor-endpoint-lease";
import {
  parseSupervisorInboxEnvelope,
  SUPERVISOR_INBOX_EVENT_SCHEMA,
  type SupervisorInboxEvent,
} from "./supervisor-inbox-stream";

/**
 * ra1 client side of `GET {routePath}/sessions/<slug>/inbox`: hold the
 * stream for one fixed identity and fence, deliver each event once, and
 * resume after a drop from the last event delivered (`Last-Event-ID`).
 *
 * - An event is delivered before the cursor moves past it. A delivery that
 *   fails drops the connection; the next one resumes at that event, so
 *   nothing is lost. An event at or below the cursor is never delivered
 *   again by this client, so a resume duplicates nothing.
 * - Events are delivered one at a time, in sequence order; while one is
 *   being delivered the stream is not read, which is what bounds the
 *   server's queue for this connection.
 * - Reconnects follow a dropped stream only, with exponential backoff (the
 *   server's `retry` as the floor): this is not a polling loop.
 * - A message event that does not parse is never skipped: the connection is
 *   dropped and the next one resumes from the last event delivered
 *   (`Last-Event-ID`), so the server sends it again. Skipping it would move
 *   the cursor past it with the next good event, and it would be lost.
 * - A fenced lease (a takeover, a release) or a refused identity ends the
 *   stream for good: identity is fixed per session, and only an explicit
 *   claim takes a lease back. A refused session token that another process
 *   of this session has since refreshed is retried with the current one.
 * - Reading is not the ACK: the session acknowledges on the recipient route.
 */

export interface InboxStreamFrame {
  data: string;
  event: string;
  id?: string;
}

const LINE_END_RE = /\r\n|\r|\n/;
const RETRY_RE = /^\d{1,9}$/;

/**
 * Accumulates SSE lines into frames: `event`, `data` (joined by newlines),
 * `id` and `retry`; comments are ignored. `line` returns a frame at the blank
 * line that ends it.
 */
class SseFrameAccumulator {
  #event = "";
  #data: string[] = [];
  #id: string | undefined;
  readonly #onRetry: ((ms: number) => void) | undefined;

  constructor(onRetry?: (ms: number) => void) {
    this.#onRetry = onRetry;
  }

  line(line: string): InboxStreamFrame | undefined {
    if (line === "") {
      return this.#dispatch();
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const raw = colon === -1 ? "" : line.slice(colon + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "event") {
      this.#event = value;
    } else if (field === "data") {
      this.#data.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      this.#id = value;
    } else if (field === "retry" && RETRY_RE.test(value)) {
      this.#onRetry?.(Number(value));
    }
    return undefined;
  }

  #dispatch(): InboxStreamFrame | undefined {
    const frame =
      this.#data.length > 0 || this.#event
        ? {
            data: this.#data.join("\n"),
            event: this.#event || "message",
            ...(this.#id === undefined ? {} : { id: this.#id }),
          }
        : undefined;
    this.#event = "";
    this.#data = [];
    this.#id = undefined;
    return frame;
  }
}

/**
 * Splits off every complete line. A trailing `\r` waits for the next chunk,
 * which may continue it as `\r\n`.
 */
const takeLines = (buffer: string): { lines: string[]; rest: string } => {
  const lines: string[] = [];
  let rest = buffer;
  let match = LINE_END_RE.exec(rest);
  while (match && !(match[0] === "\r" && match.index === rest.length - 1)) {
    lines.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
    match = LINE_END_RE.exec(rest);
  }
  return { lines, rest };
};

/**
 * The SSE wire format from a byte stream. A frame ends at a blank line; a
 * trailing partial frame at the end of the stream is discarded, as
 * EventSource does.
 */
export async function* parseInboxStreamFrames(
  body: ReadableStream<Uint8Array>,
  onRetry?: (ms: number) => void
): AsyncGenerator<InboxStreamFrame> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const frames = new SseFrameAccumulator(onRetry);
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      const taken = takeLines(buffer + decoder.decode(value, { stream: true }));
      buffer = taken.rest;
      for (const line of taken.lines) {
        const frame = frames.line(line);
        if (frame) {
          yield frame;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** One inbox event's data, strictly: schema, sequence, canonical envelope. */
export const parseInboxStreamEvent = (
  frame: InboxStreamFrame
): SupervisorInboxEvent => {
  const value: unknown = JSON.parse(frame.data);
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).schema ===
        SUPERVISOR_INBOX_EVENT_SCHEMA
    )
  ) {
    throw new Error("inbox event schema is invalid");
  }
  const record = value as Record<string, unknown>;
  const seq = record.seq;
  if (
    !(Number.isSafeInteger(seq) && Number(seq) >= 1) ||
    frame.id !== String(seq) ||
    typeof record.appendedAt !== "string"
  ) {
    throw new Error("inbox event sequence is invalid");
  }
  return {
    appendedAt: record.appendedAt,
    envelope: parseSupervisorInboxEnvelope(record.envelope),
    schema: SUPERVISOR_INBOX_EVENT_SCHEMA,
    seq: Number(seq),
  };
};

export type InboxStreamEnd =
  | { reason: "aborted" }
  /** The lease moved (takeover, release) or no longer names this holder. */
  | { reason: "fenced"; detail: string }
  /** 401/403: this identity may not stream this inbox. */
  | { reason: "refused"; detail: string };

export interface InboxStreamClientOptions {
  /** Delivers one event; resolves false (or throws) when it was not delivered. */
  deliver(event: SupervisorInboxEvent): Promise<boolean>;
  endpoint: A2AClientEndpoint;
  fence: SupervisorEndpointLeaseFence;
  fetchImpl?: typeof fetch;
  /** Resume after this sequence (a previous run's cursor). */
  initialCursor?: number;
  log?: (line: string) => void;
  maxBackoffMs?: number;
  minBackoffMs?: number;
  signal: AbortSignal;
  /** Test seam for backoff waits. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

const reasonOf = (value: unknown): string =>
  typeof value === "string" ? value : "lease-fenced";

const fencedDetail = (data: string): string => {
  try {
    return reasonOf((JSON.parse(data) as { reason?: unknown }).reason);
  } catch {
    return "lease-fenced";
  }
};

type ConnectionOutcome =
  | { kind: "end"; end: InboxStreamEnd }
  /** The connection dropped (or a delivery failed): reconnect. */
  | { kind: "retry"; progressed: boolean };

/**
 * Holds the inbox stream until the signal aborts, the lease is fenced, or
 * the identity is refused. The cursor it resumes from is its own record of
 * delivered events.
 */
export class InboxStreamClient {
  readonly #options: InboxStreamClientOptions;
  #cursor: number;
  #retryFloorMs: number;

  constructor(options: InboxStreamClientOptions) {
    this.#options = options;
    this.#cursor = options.initialCursor ?? 0;
    this.#retryFloorMs = options.minBackoffMs ?? 500;
  }

  /** The sequence of the last event delivered. */
  get cursor(): number {
    return this.#cursor;
  }

  async run(): Promise<InboxStreamEnd> {
    const { signal } = this.#options;
    const sleep = this.#options.sleep ?? abortableSleep;
    const maxBackoff = this.#options.maxBackoffMs ?? 30_000;
    let failures = 0;
    while (!signal.aborted) {
      const outcome = await this.#connectOnce();
      if (outcome.kind === "end") {
        return outcome.end;
      }
      failures = outcome.progressed ? 0 : failures + 1;
      const delay = Math.min(
        maxBackoff,
        this.#retryFloorMs * 2 ** Math.min(failures, 10)
      );
      await sleep(delay, signal);
    }
    return { reason: "aborted" };
  }

  async #connectOnce(): Promise<ConnectionOutcome> {
    const { signal } = this.#options;
    const connection = new AbortController();
    const onAbort = () => connection.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const progress = { made: false };
    try {
      const opened = await this.#open(connection.signal);
      if (!(opened instanceof Response)) {
        return opened;
      }
      return await this.#consume(opened, progress);
    } catch {
      return this.#dropped(progress.made);
    } finally {
      signal.removeEventListener("abort", onAbort);
      connection.abort();
    }
  }

  #dropped(progressed: boolean): ConnectionOutcome {
    return this.#options.signal.aborted
      ? { end: { reason: "aborted" }, kind: "end" }
      : { kind: "retry", progressed };
  }

  /** The stream's response, or how this connection ended without one. */
  async #open(
    connectionSignal: AbortSignal
  ): Promise<ConnectionOutcome | Response> {
    const { endpoint, fence } = this.#options;
    let token: string;
    try {
      token = await endpoint.token();
    } catch (error) {
      // A session that must enroll again: no reconnect can fix it.
      return {
        end: {
          detail: error instanceof Error ? error.message : "no credential",
          reason: "refused",
        },
        kind: "end",
      };
    }
    let response: Response;
    try {
      response = await endpoint.fetch(this.#options.fetchImpl ?? fetch)(
        endpoint.url(
          a2aV2SessionInboxPath(endpoint.routePath, endpoint.supervisorId)
        ),
        {
          headers: {
            accept: "text/event-stream",
            authorization: `Bearer ${token}`,
            [A2A_V2_LEASE_EPOCH_HEADER]: String(fence.epoch),
            [A2A_V2_LEASE_HOLDER_HEADER]: fence.holderRef,
            ...(this.#cursor > 0
              ? { "last-event-id": String(this.#cursor) }
              : {}),
          },
          method: "GET",
          redirect: "error",
          signal: connectionSignal,
        }
      );
    } catch {
      return this.#dropped(false);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 && (await endpoint.superseded(token))) {
        return { kind: "retry", progressed: false };
      }
      return {
        end: { detail: `HTTP ${response.status}`, reason: "refused" },
        kind: "end",
      };
    }
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { reason?: unknown };
      };
      return {
        end: { detail: reasonOf(body.error?.reason), reason: "fenced" },
        kind: "end",
      };
    }
    if (!(response.ok && response.body)) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "retry", progressed: false };
    }
    return response;
  }

  /** Delivers each new event in order; ends at a fence or a failed delivery. */
  async #consume(
    response: Response,
    progress: { made: boolean }
  ): Promise<ConnectionOutcome> {
    const frames = parseInboxStreamFrames(
      response.body as ReadableStream<Uint8Array>,
      (ms) => {
        this.#retryFloorMs = Math.max(ms, 100);
      }
    );
    for await (const frame of frames) {
      if (frame.event === "fenced") {
        return {
          end: { detail: fencedDetail(frame.data), reason: "fenced" },
          kind: "end",
        };
      }
      const event = this.#newEvent(frame);
      if (event === "invalid") {
        // Never skip it: resync from the last event delivered.
        return { kind: "retry", progressed: progress.made };
      }
      if (!event) {
        continue;
      }
      if (!(await this.#deliver(event))) {
        // Resume at this event on the next connection.
        return { kind: "retry", progressed: progress.made };
      }
      this.#cursor = event.seq;
      progress.made = true;
    }
    return this.#dropped(progress.made);
  }

  /**
   * A message event past the cursor; undefined for another event or one
   * already delivered; "invalid" for a message event that does not parse.
   */
  #newEvent(
    frame: InboxStreamFrame
  ): SupervisorInboxEvent | "invalid" | undefined {
    if (frame.event !== "message") {
      return undefined;
    }
    let event: SupervisorInboxEvent;
    try {
      event = parseInboxStreamEvent(frame);
    } catch {
      this.#options.log?.(
        `[loop connect] an inbox event did not parse; resyncing after ${this.#cursor}`
      );
      return "invalid";
    }
    return event.seq > this.#cursor ? event : undefined;
  }

  async #deliver(event: SupervisorInboxEvent): Promise<boolean> {
    try {
      return (await this.#options.deliver(event)) === true;
    } catch {
      return false;
    }
  }
}
