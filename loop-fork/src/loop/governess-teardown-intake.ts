import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { sleepSync } from "bun";

/**
 * Operator teardown requests recorded by the Attention OS control surface.
 *
 * The control surface (producer branch) appends a `requested` event for a
 * `lifecycle-teardown` into `<runDir>/interaction-actions/events.jsonl`; the
 * run's own Governess is the only party that may execute it. This reader is
 * wire-compatible with that journal: same paths, lock file protocol, request
 * shape, request-id derivation and terminal events, so the producer reports
 * the phase (pending, accepted, denied, failed) to the phone unchanged.
 *
 * Only teardown is handled here. Other request kinds in the same journal are
 * left pending for a Governess that implements them.
 */

const INTAKE_VERSION = "1";
const TEARDOWN_KIND = "lifecycle-teardown";
const MAX_TEARDOWN_REASON_LENGTH = 200;
const MAX_EVENT_BYTES = 8192;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const LOCK_ACQUIRE_TIMEOUT_MS = 2000;
const LOCK_RETRY_INTERVAL_MS = 5;
const TERMINAL_TYPES = new Set(["accepted", "denied", "failed"]);
const TEARDOWN_KEYS = [
  "idempotencyKeyHash",
  "kind",
  "reason",
  "repoId",
  "requestId",
  "runId",
  "submittedAt",
  "version",
].sort();
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface TeardownRequest {
  readonly idempotencyKeyHash: string;
  readonly kind: typeof TEARDOWN_KIND;
  readonly reason: string;
  readonly repoId: string;
  readonly requestId: string;
  readonly runId: string;
  readonly submittedAt: string;
  readonly version: typeof INTAKE_VERSION;
}

export interface TeardownIntakeInput {
  /** False leaves the request pending: an unfenced Governess cannot stop the run. */
  readonly fenceCurrent: () => boolean;
  readonly now: () => number;
  readonly repoId: string;
  readonly runDir: string;
  readonly runId: string;
  readonly teardown: (reason: string) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

const isBoundedIdentifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !hasControlCharacter(value);

const isCanonicalTime = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

/** Identical to the producer's derivation, so ids agree across builds. */
export const teardownRequestId = (
  repoId: string,
  runId: string,
  idempotencyKeyHash: string
): string =>
  `iar_${createHash("sha256")
    .update(`${TEARDOWN_KIND}|${repoId}|${runId}|${idempotencyKeyHash}`)
    .digest("hex")
    .slice(0, 32)}`;

export const isTeardownRequest = (value: unknown): value is TeardownRequest => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== TEARDOWN_KEYS.length ||
    keys.some((key, index) => key !== TEARDOWN_KEYS[index])
  ) {
    return false;
  }
  return (
    value.version === INTAKE_VERSION &&
    value.kind === TEARDOWN_KIND &&
    isBoundedIdentifier(value.repoId) &&
    isBoundedIdentifier(value.runId) &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= MAX_TEARDOWN_REASON_LENGTH &&
    value.reason.trim() === value.reason &&
    !hasControlCharacter(value.reason) &&
    typeof value.idempotencyKeyHash === "string" &&
    SHA256_PATTERN.test(value.idempotencyKeyHash) &&
    value.requestId ===
      teardownRequestId(value.repoId, value.runId, value.idempotencyKeyHash) &&
    isCanonicalTime(value.submittedAt)
  );
};

const intakePaths = (runDir: string) => {
  const rootDir = join(runDir, "interaction-actions");
  return {
    eventsFile: join(rootDir, "events.jsonl"),
    lockFile: join(rootDir, "events.lock"),
    rootDir,
  };
};

const readJournal = (eventsFile: string): Record<string, unknown>[] => {
  let text: string;
  try {
    const stat = lstatSync(eventsFile);
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) {
      throw new Error("teardown intake journal is unsafe");
    }
    text = readFileSync(eventsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed.requestId !== "string") {
      throw new Error("teardown intake journal is malformed");
    }
    events.push(parsed);
  }
  return events;
};

/** Teardown requests with no terminal event yet, oldest first. */
export const pendingTeardowns = (runDir: string): TeardownRequest[] => {
  const requested = new Map<string, TeardownRequest>();
  const terminal = new Set<string>();
  for (const event of readJournal(intakePaths(runDir).eventsFile)) {
    const requestId = event.requestId as string;
    if (event.type === "requested" && isTeardownRequest(event.request)) {
      requested.set(requestId, event.request);
    } else if (TERMINAL_TYPES.has(String(event.type))) {
      terminal.add(requestId);
    }
  }
  return [...requested.entries()]
    .filter(([requestId]) => !terminal.has(requestId))
    .map(([, request]) => request);
};

const acquireLock = (
  lockFile: string
): { descriptor: number; token: string } => {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const token = randomUUID();
      const descriptor = openSync(lockFile, "wx", 0o600);
      writeSync(descriptor, `${JSON.stringify({ pid: process.pid, token })}\n`);
      fsyncSync(descriptor);
      return { descriptor, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("interaction action intake is busy");
      }
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
};

const releaseLock = (
  lockFile: string,
  lock: { descriptor: number; token: string }
) => {
  closeSync(lock.descriptor);
  try {
    const record = JSON.parse(readFileSync(lockFile, "utf8")) as unknown;
    if (isRecord(record) && record.token === lock.token) {
      unlinkSync(lockFile);
    }
  } catch {
    // The next reader re-validates the journal.
  }
};

const appendTerminal = (
  eventsFile: string,
  requestId: string,
  type: "accepted" | "denied" | "failed",
  now: number,
  reason?: string
): void => {
  const event = {
    at: new Date(now).toISOString(),
    eventId: `${type}:${requestId}:${randomUUID()}`,
    ...(reason ? { reason } : {}),
    requestId,
    type,
    version: INTAKE_VERSION,
  };
  const encoded = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(encoded) > MAX_EVENT_BYTES) {
    throw new Error("teardown intake event is oversized");
  }
  const descriptor = openSync(
    eventsFile,
    constants.O_WRONLY + constants.O_APPEND + constants.O_NOFOLLOW
  );
  try {
    writeSync(descriptor, encoded);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Execute pending operator teardowns addressed to this run. Returns the number
 * of requests given a terminal event. The accepted event is written before the
 * teardown runs, and only while the fence is current, matching the producer's
 * own Governess so a declined executor never leaves a false "accepted".
 */
export const processPendingTeardowns = (input: TeardownIntakeInput): number => {
  const paths = intakePaths(input.runDir);
  if (pendingTeardowns(input.runDir).length === 0) {
    return 0;
  }
  mkdirSync(paths.rootDir, { recursive: true });
  if (!lstatSync(paths.rootDir).isDirectory()) {
    throw new Error("interaction action intake root is unsafe");
  }
  const lock = acquireLock(paths.lockFile);
  let processed = 0;
  try {
    for (const request of pendingTeardowns(input.runDir)) {
      if (!(request.repoId === input.repoId && request.runId === input.runId)) {
        appendTerminal(
          paths.eventsFile,
          request.requestId,
          "denied",
          input.now(),
          "lifecycle-run-mismatch"
        );
        processed += 1;
        continue;
      }
      if (!input.fenceCurrent()) {
        continue;
      }
      appendTerminal(
        paths.eventsFile,
        request.requestId,
        "accepted",
        input.now()
      );
      processed += 1;
      input.teardown(request.reason);
      break;
    }
  } finally {
    releaseLock(paths.lockFile, lock);
  }
  return processed;
};
