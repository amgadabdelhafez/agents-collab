import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type GovernessLifecycleEvent,
  lifecycleEventFromEvidence,
} from "./governess-runtime";
import type { Agent, HookEvent } from "./types";

export const PUBLIC_ASK_JOURNAL_NAME = "public-human-asks.jsonl";
export const MAX_PUBLIC_ASK_RECORDS = 256;
export const MAX_PUBLIC_ASK_JOURNAL_BYTES = 512 * 1024;
export const MAX_PUBLIC_ASK_RECORD_BYTES = 4096;
export const MAX_PUBLIC_ASK_TITLE_LENGTH = 80;
export const MAX_PUBLIC_ASK_PROMPT_LENGTH = 280;
export const MAX_PUBLIC_ASK_CONSEQUENCE_LENGTH = 240;

const ASK_ID_PATTERN = /^ask_[0-9a-f]{32}$/u;
const BOUNDED_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DISPLAY_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,!?'()_-]*$/u;
const FORBIDDEN_PUBLIC_TEXT =
  /(?:\/|\\|:\/\/|@|`|\$\{|-----BEGIN|\b(?:api[ _-]?key|password|secret|token)\b)/iu;
const AGENTS = new Set<Agent>(["claude", "codex", "oss"]);
const RESPONSE_ID_PATTERN = /^resp_[0-9a-f]{32}$/u;
const ACTIVE_MANIFEST_STATES = new Set([
  "submitted",
  "working",
  "reviewing",
  "input-required",
]);

export interface PublicAskBindingV1 {
  readonly agent: Agent;
  readonly epoch: number;
  readonly repoId: string;
  readonly runId: string;
  readonly sequence: number;
}

export interface PublicAskConsequenceV1 {
  readonly digest: string;
  readonly statement: string;
}

export interface PublicAskResponseV1 {
  readonly intents: readonly ("answer" | "approve" | "reject")[];
  readonly mode: "approve-reject" | "short-answer";
}

export interface PublicAskResponseCorrelationV1 {
  readonly resolvedAt: string;
  readonly responseId: string;
}

export interface PublicAskRecordV1 {
  readonly authority: "agent-response-only";
  readonly binding: PublicAskBindingV1;
  readonly consequence?: PublicAskConsequenceV1;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: "approval" | "question";
  readonly prompt: string;
  readonly response: PublicAskResponseV1;
  readonly responseCorrelation?: PublicAskResponseCorrelationV1;
  readonly state: "open" | "resolved";
  readonly title: string;
  readonly updatedAt: string;
  readonly version: "1";
}

export type PublicAskPublishInput =
  | {
      readonly consequence: string;
      readonly kind: "approval";
      readonly prompt: string;
      readonly title: string;
    }
  | {
      readonly kind: "question";
      readonly prompt: string;
      readonly title: string;
    };

export interface PublicAskPublishOptions {
  readonly afterAuthorityRecheck?: () => void;
  readonly afterEvidenceRead?: () => void;
  readonly afterJournalOpen?: (path: string) => void;
  readonly now?: () => string;
}

export interface PublicAskDecisionResolutionInput {
  readonly askId: string;
  readonly binding: PublicAskBindingV1;
  readonly intent: "approve" | "reject";
  readonly resolvedAt: string;
}

export interface PublicAskAnswerResolutionInput {
  readonly askId: string;
  readonly binding: PublicAskBindingV1;
  readonly resolvedAt: string;
  readonly value: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, i) => key === keys[i])
  );
};

const isCanonicalTime = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
};

const isBoundedIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  BOUNDED_IDENTITY_PATTERN.test(value);

export const isPublicAskDisplayText = (
  value: unknown,
  maxLength: number
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxLength &&
  value.trim() === value &&
  DISPLAY_TEXT_PATTERN.test(value) &&
  !FORBIDDEN_PUBLIC_TEXT.test(value);

export const publicAskConsequenceDigest = (statement: string): string =>
  createHash("sha256")
    .update(`public-ask-consequence/v1|${statement}`)
    .digest("hex");

export const publicAskId = (binding: PublicAskBindingV1): string =>
  `ask_${createHash("sha256")
    .update(
      `public-ask/v1|${binding.repoId}|${binding.runId}|${binding.agent}|${binding.epoch}|${binding.sequence}`
    )
    .digest("hex")
    .slice(0, 32)}`;

export const publicAskDecisionResponseId = (
  askId: string,
  intent: PublicAskDecisionResolutionInput["intent"]
): string =>
  `resp_${createHash("sha256")
    .update(`public-ask-decision/v1|${askId}|${intent}`)
    .digest("hex")
    .slice(0, 32)}`;

export const publicAskAnswerResponseId = (
  askId: string,
  value: string
): string =>
  `resp_${createHash("sha256")
    .update(`public-ask-answer/v1|${askId}|${value}`)
    .digest("hex")
    .slice(0, 32)}`;

const responseFor = (kind: PublicAskRecordV1["kind"]): PublicAskResponseV1 =>
  kind === "approval"
    ? { intents: ["approve", "reject"], mode: "approve-reject" }
    : { intents: ["answer"], mode: "short-answer" };

const validBinding = (value: unknown): value is PublicAskBindingV1 =>
  isRecord(value) &&
  exactKeys(value, ["agent", "epoch", "repoId", "runId", "sequence"]) &&
  typeof value.agent === "string" &&
  AGENTS.has(value.agent as Agent) &&
  Number.isSafeInteger(value.epoch) &&
  Number(value.epoch) >= 0 &&
  isBoundedIdentity(value.repoId) &&
  isBoundedIdentity(value.runId) &&
  Number.isSafeInteger(value.sequence) &&
  Number(value.sequence) >= 1;

const validConsequence = (value: unknown): value is PublicAskConsequenceV1 =>
  isRecord(value) &&
  exactKeys(value, ["digest", "statement"]) &&
  isPublicAskDisplayText(value.statement, MAX_PUBLIC_ASK_CONSEQUENCE_LENGTH) &&
  value.digest === publicAskConsequenceDigest(value.statement);

const validCorrelation = (
  value: unknown
): value is PublicAskResponseCorrelationV1 =>
  isRecord(value) &&
  exactKeys(value, ["resolvedAt", "responseId"]) &&
  isCanonicalTime(value.resolvedAt) &&
  typeof value.responseId === "string" &&
  RESPONSE_ID_PATTERN.test(value.responseId);

export const isPublicAskRecord = (
  value: unknown
): value is PublicAskRecordV1 => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = [
    "authority",
    "binding",
    ...(value.consequence === undefined ? [] : ["consequence"]),
    "createdAt",
    "id",
    "kind",
    "prompt",
    "response",
    ...(value.responseCorrelation === undefined ? [] : ["responseCorrelation"]),
    "state",
    "title",
    "updatedAt",
    "version",
  ].sort();
  if (
    !(
      exactKeys(value, keys) &&
      value.version === "1" &&
      value.authority === "agent-response-only" &&
      validBinding(value.binding) &&
      typeof value.id === "string" &&
      ASK_ID_PATTERN.test(value.id) &&
      value.id === publicAskId(value.binding) &&
      (value.kind === "approval" || value.kind === "question") &&
      isPublicAskDisplayText(value.title, MAX_PUBLIC_ASK_TITLE_LENGTH) &&
      isPublicAskDisplayText(value.prompt, MAX_PUBLIC_ASK_PROMPT_LENGTH) &&
      isCanonicalTime(value.createdAt) &&
      isCanonicalTime(value.updatedAt) &&
      Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
      (value.state === "open" || value.state === "resolved") &&
      isRecord(value.response) &&
      JSON.stringify(value.response) === JSON.stringify(responseFor(value.kind))
    )
  ) {
    return false;
  }
  if (value.kind === "approval") {
    if (!validConsequence(value.consequence)) {
      return false;
    }
  } else if (value.consequence !== undefined) {
    return false;
  }
  return value.state === "open"
    ? value.responseCorrelation === undefined
    : validCorrelation(value.responseCorrelation);
};

const retryKey = (record: PublicAskRecordV1): string =>
  JSON.stringify({
    authority: record.authority,
    binding: record.binding,
    consequence: record.consequence,
    kind: record.kind,
    prompt: record.prompt,
    response: record.response,
    state: record.state,
    title: record.title,
    version: record.version,
  });

const immutableAskKey = (record: PublicAskRecordV1): string =>
  JSON.stringify({
    authority: record.authority,
    binding: record.binding,
    consequence: record.consequence,
    createdAt: record.createdAt,
    id: record.id,
    kind: record.kind,
    prompt: record.prompt,
    response: record.response,
    title: record.title,
    version: record.version,
  });

const exactRecordKey = (record: PublicAskRecordV1): string =>
  JSON.stringify(record);

const resolveTransition = (
  current: PublicAskRecordV1,
  next: PublicAskRecordV1
): PublicAskRecordV1 => {
  if (exactRecordKey(current) === exactRecordKey(next)) {
    return current;
  }
  if (
    current.state !== "open" ||
    next.state !== "resolved" ||
    immutableAskKey(current) !== immutableAskKey(next) ||
    Date.parse(next.updatedAt) <= Date.parse(current.updatedAt) ||
    next.responseCorrelation?.resolvedAt !== next.updatedAt
  ) {
    throw new Error("public ask journal contains a conflict");
  }
  return next;
};

export const parsePublicAskRecords = (value: unknown): PublicAskRecordV1[] => {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_ASK_RECORDS) {
    throw new Error("public ask journal is invalid");
  }
  const byId = new Map<string, PublicAskRecordV1>();
  for (const candidate of value) {
    if (!isPublicAskRecord(candidate)) {
      throw new Error("public ask journal is invalid");
    }
    const current = byId.get(candidate.id);
    if (!current) {
      if (candidate.state !== "open") {
        throw new Error("public ask journal contains a conflict");
      }
      byId.set(candidate.id, candidate);
      continue;
    }
    byId.set(candidate.id, resolveTransition(current, candidate));
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
  );
};

const assertDirectory = (path: string, descriptor: number): BigIntStats => {
  const openStats = fstatSync(descriptor, { bigint: true });
  const pathStats = lstatSync(path, { bigint: true });
  if (
    !openStats.isDirectory() ||
    pathStats.isSymbolicLink() ||
    openStats.dev !== pathStats.dev ||
    openStats.ino !== pathStats.ino
  ) {
    throw new Error("public ask root is unsafe");
  }
  return openStats;
};

const assertJournal = (path: string, descriptor: number): BigIntStats => {
  const openStats = fstatSync(descriptor, { bigint: true });
  const pathStats = lstatSync(path, { bigint: true });
  if (
    !openStats.isFile() ||
    openStats.nlink !== 1n ||
    pathStats.isSymbolicLink() ||
    openStats.dev !== pathStats.dev ||
    openStats.ino !== pathStats.ino ||
    openStats.size > BigInt(MAX_PUBLIC_ASK_JOURNAL_BYTES)
  ) {
    throw new Error("public ask journal is unsafe");
  }
  return openStats;
};

const readSafeFile = (path: string, maxBytes: number): string => {
  const parent = dirname(path);
  const directory = openSync(
    parent,
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
  );
  let descriptor: number | undefined;
  try {
    assertDirectory(parent, directory);
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are a bitmask.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = assertJournal(path, descriptor);
    if (before.size > BigInt(maxBytes)) {
      throw new Error("public ask evidence is oversized");
    }
    const text = readFileSync(descriptor, "utf8");
    const after = assertJournal(path, descriptor);
    assertDirectory(parent, directory);
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error("public ask evidence changed during read");
    }
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("public ask evidence is unsafe");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    closeSync(directory);
  }
};

const parseJournalText = (text: string): PublicAskRecordV1[] => {
  if (!text) {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("public ask journal is malformed");
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    if (Buffer.byteLength(line) > MAX_PUBLIC_ASK_RECORD_BYTES) {
      throw new Error("public ask journal is oversized");
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error("public ask journal is malformed");
    }
  }
  return parsePublicAskRecords(rows);
};

const journalPath = (runDir: string): string =>
  join(runDir, PUBLIC_ASK_JOURNAL_NAME);

export const readPublicAskRecords = (runDir: string): PublicAskRecordV1[] => {
  const path = journalPath(runDir);
  try {
    return parseJournalText(readSafeFile(path, MAX_PUBLIC_ASK_JOURNAL_BYTES));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    if (error instanceof Error && error.message.includes("unsafe")) {
      throw error;
    }
    throw error;
  }
};

const writeAll = (descriptor: number, value: string): void => {
  const bytes = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) {
      throw new Error("public ask journal write was incomplete");
    }
    offset += written;
  }
};

interface PublicAskLock {
  readonly descriptor: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly path: string;
  readonly runDir: string;
}

const acquireLock = (runDir: string): PublicAskLock => {
  const path = join(runDir, ".public-human-asks.lock");
  let directory: number | undefined;
  let descriptor: number | undefined;
  try {
    directory = openSync(
      runDir,
      constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
    );
    assertDirectory(runDir, directory);
    descriptor = openSync(
      path,
      constants.O_RDWR +
        constants.O_CREAT +
        constants.O_EXCL +
        constants.O_NOFOLLOW,
      0o600
    );
    writeAll(descriptor, `${randomUUID()}\n`);
    fsyncSync(descriptor);
    const stats = assertJournal(path, descriptor);
    assertDirectory(runDir, directory);
    fsyncSync(directory);
    return { descriptor, dev: stats.dev, ino: stats.ino, path, runDir };
  } catch {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    throw new Error("public ask journal is busy or unsafe");
  } finally {
    if (directory !== undefined) {
      closeSync(directory);
    }
  }
};

const releaseLock = (lock: PublicAskLock): void => {
  closeSync(lock.descriptor);
  let directory: number | undefined;
  try {
    directory = openSync(
      lock.runDir,
      constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
    );
    assertDirectory(lock.runDir, directory);
    const current = lstatSync(lock.path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      current.dev !== lock.dev ||
      current.ino !== lock.ino
    ) {
      return;
    }
    unlinkSync(lock.path);
    fsyncSync(directory);
  } catch {
    // A retained lock fails future producers closed.
  } finally {
    if (directory !== undefined) {
      closeSync(directory);
    }
  }
};

const readProducerEpisode = (
  runDir: string,
  agent: Agent
): PublicAskBindingV1 => {
  let manifest: unknown;
  let governess: unknown;
  try {
    manifest = JSON.parse(
      readSafeFile(join(runDir, "manifest.json"), 2 * 1024 * 1024)
    );
    governess = JSON.parse(
      readSafeFile(join(runDir, "governess-state.json"), 2 * 1024 * 1024)
    );
  } catch {
    throw new Error("public ask durable state is unavailable");
  }
  const lifecycleEvents = isRecord(governess)
    ? governess.lifecycleEvents
    : undefined;
  const episode = isRecord(lifecycleEvents)
    ? lifecycleEvents[agent]
    : undefined;
  if (
    !(
      isRecord(manifest) &&
      isBoundedIdentity(manifest.repoId) &&
      isBoundedIdentity(manifest.runId) &&
      manifest.status === "running" &&
      typeof manifest.state === "string" &&
      ACTIVE_MANIFEST_STATES.has(manifest.state) &&
      isRecord(episode) &&
      episode.agent === agent &&
      (episode.state === "input-required" || episode.state === "working") &&
      Number.isSafeInteger(episode.epoch) &&
      Number(episode.epoch) >= 0 &&
      Number.isSafeInteger(episode.sequence) &&
      Number(episode.sequence) >= 1 &&
      isCanonicalTime(episode.at)
    )
  ) {
    throw new Error(
      "agent-scoped bridge source has no current input-required episode"
    );
  }
  // In tmux every wake is typed into the pane, so an agent is always working
  // when it can call the tool. An ask published mid-turn belongs to the idle
  // episode that ends the turn: episodes change only with state, so that is
  // exactly the next sequence. The Governess records episodes on its own
  // tick, so first fold the hooks it has not consumed yet; otherwise an ask
  // published before the tick that sees this turn binds to the idle episode
  // the turn already left. The projection shows it only if that episode is
  // in fact input-required.
  const current = foldUnconsumedHooks(
    runDir,
    agent,
    episode as unknown as GovernessLifecycleEvent
  );
  return {
    agent,
    epoch: Number(episode.epoch),
    repoId: manifest.repoId,
    runId: manifest.runId,
    sequence: current.sequence + (current.state === "working" ? 1 : 0),
  };
};

const MAX_PRODUCER_HOOK_BYTES = 8 * 1024 * 1024;

const foldUnconsumedHooks = (
  runDir: string,
  agent: Agent,
  episode: GovernessLifecycleEvent
): GovernessLifecycleEvent => {
  let hooks: HookEvent[];
  try {
    hooks = readSafeFile(
      join(runDir, "hooks", `${agent}.jsonl`),
      MAX_PRODUCER_HOOK_BYTES
    )
      .split("\n")
      .flatMap((line) => {
        if (line.trim().length === 0) {
          return [];
        }
        try {
          return [JSON.parse(line) as HookEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return episode;
  }
  return (
    lifecycleEventFromEvidence(episode, {
      agent,
      at: episode.at,
      epoch: episode.epoch,
      // Without hook evidence the recorded episode stands unchanged.
      fallback: { alive: true, evidence: "", state: episode.state },
      hooks,
    }) ?? episode
  );
};

const validateInput = (input: PublicAskPublishInput): void => {
  const value = input as unknown;
  if (!isRecord(value)) {
    throw new Error("public ask input is invalid");
  }
  const expectedKeys =
    value.kind === "approval"
      ? ["consequence", "kind", "prompt", "title"]
      : ["kind", "prompt", "title"];
  if (
    !(
      (value.kind === "approval" || value.kind === "question") &&
      exactKeys(value, expectedKeys)
    )
  ) {
    throw new Error("public ask input is invalid");
  }
  if (
    !(
      isPublicAskDisplayText(input.title, MAX_PUBLIC_ASK_TITLE_LENGTH) &&
      isPublicAskDisplayText(input.prompt, MAX_PUBLIC_ASK_PROMPT_LENGTH)
    )
  ) {
    throw new Error("public ask contains invalid public display text");
  }
  if (
    input.kind === "approval" &&
    !isPublicAskDisplayText(
      input.consequence,
      MAX_PUBLIC_ASK_CONSEQUENCE_LENGTH
    )
  ) {
    throw new Error("public ask contains invalid public display text");
  }
};

/**
 * Whether the run could host a public ask at all: its manifest is readable and
 * active. Agents list MCP tools once, at session start, while they are still
 * working, so advertising the tool only during an input-required episode meant
 * it never appeared. The episode itself is still enforced when the tool is
 * called (see publishPublicAsk).
 */
export const isPublicAskRunActive = (runDir: string): boolean => {
  try {
    const manifest = JSON.parse(
      readSafeFile(join(runDir, "manifest.json"), 2 * 1024 * 1024)
    ) as unknown;
    return (
      isRecord(manifest) &&
      manifest.status === "running" &&
      typeof manifest.state === "string" &&
      ACTIVE_MANIFEST_STATES.has(manifest.state)
    );
  } catch {
    return false;
  }
};

export const hasCurrentPublicAskEpisode = (
  runDir: string,
  agent: Agent
): boolean => {
  try {
    readProducerEpisode(runDir, agent);
    return true;
  } catch {
    return false;
  }
};

const appendRecord = (
  runDir: string,
  expectedText: string,
  record: PublicAskRecordV1,
  afterOpen?: (path: string) => void,
  assertCurrent?: () => void,
  afterAuthorityRecheck?: () => void,
  reserveTerminal = false
): void => {
  const path = journalPath(runDir);
  const directory = openSync(
    runDir,
    constants.O_RDONLY + constants.O_DIRECTORY + constants.O_NOFOLLOW
  );
  let descriptor: number | undefined;
  let created = false;
  try {
    assertDirectory(runDir, directory);
    try {
      descriptor = openSync(
        path,
        constants.O_RDWR + constants.O_APPEND + constants.O_NOFOLLOW
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("public ask journal is unsafe");
      }
      descriptor = openSync(
        path,
        constants.O_RDWR +
          constants.O_APPEND +
          constants.O_CREAT +
          constants.O_EXCL +
          constants.O_NOFOLLOW,
        0o600
      );
      created = true;
    }
    afterOpen?.(path);
    const before = assertJournal(path, descriptor);
    assertDirectory(runDir, directory);
    const currentText = readFileSync(descriptor, "utf8");
    if (currentText !== expectedText) {
      throw new Error("public ask journal changed before append");
    }
    const currentAsks = parseJournalText(currentText);
    const terminalReservations = reserveTerminal
      ? currentAsks.filter((candidate) => candidate.state === "open").length + 1
      : 0;
    const currentRows = currentText.split("\n").length - 1;
    if (currentRows + 1 + terminalReservations > MAX_PUBLIC_ASK_RECORDS) {
      throw new Error("public ask journal is at record capacity");
    }
    assertCurrent?.();
    afterAuthorityRecheck?.();
    assertCurrent?.();
    assertDirectory(runDir, directory);
    const encoded = `${JSON.stringify(record)}\n`;
    if (
      Buffer.byteLength(encoded) > MAX_PUBLIC_ASK_RECORD_BYTES ||
      before.size +
        BigInt(Buffer.byteLength(encoded)) +
        BigInt(terminalReservations * MAX_PUBLIC_ASK_RECORD_BYTES) >
        BigInt(MAX_PUBLIC_ASK_JOURNAL_BYTES)
    ) {
      throw new Error("public ask journal is oversized");
    }
    writeAll(descriptor, encoded);
    fsyncSync(descriptor);
    const after = assertJournal(path, descriptor);
    if (after.size !== before.size + BigInt(Buffer.byteLength(encoded))) {
      throw new Error("public ask journal write was unstable");
    }
    assertDirectory(runDir, directory);
    if (created) {
      fsyncSync(directory);
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    closeSync(directory);
  }
};

export const publishPublicAsk = (
  runDir: string,
  agent: Agent,
  input: PublicAskPublishInput,
  options: PublicAskPublishOptions = {}
): PublicAskRecordV1 => {
  validateInput(input);
  const now = options.now?.() ?? new Date().toISOString();
  if (!isCanonicalTime(now)) {
    throw new Error("public ask clock is invalid");
  }
  const lock = acquireLock(runDir);
  try {
    const binding = readProducerEpisode(runDir, agent);
    options.afterEvidenceRead?.();
    const path = journalPath(runDir);
    let text = "";
    try {
      text = readSafeFile(path, MAX_PUBLIC_ASK_JOURNAL_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const existing = parseJournalText(text);
    const record: PublicAskRecordV1 = {
      authority: "agent-response-only",
      binding,
      ...(input.kind === "approval"
        ? {
            consequence: {
              digest: publicAskConsequenceDigest(input.consequence),
              statement: input.consequence,
            },
          }
        : {}),
      createdAt: now,
      id: publicAskId(binding),
      kind: input.kind,
      prompt: input.prompt,
      response: responseFor(input.kind),
      state: "open",
      title: input.title,
      updatedAt: now,
      version: "1",
    };
    const prior = existing.find((candidate) => candidate.id === record.id);
    if (prior) {
      if (retryKey(prior) !== retryKey(record)) {
        throw new Error("public ask retry conflicts with the current episode");
      }
      const finalBinding = readProducerEpisode(runDir, agent);
      if (JSON.stringify(finalBinding) !== JSON.stringify(binding)) {
        throw new Error(
          "agent-scoped bridge source has no current input-required episode"
        );
      }
      return prior;
    }
    appendRecord(
      runDir,
      text,
      record,
      options.afterJournalOpen,
      () => {
        const finalBinding = readProducerEpisode(runDir, agent);
        if (JSON.stringify(finalBinding) !== JSON.stringify(binding)) {
          throw new Error(
            "agent-scoped bridge source has no current input-required episode"
          );
        }
      },
      options.afterAuthorityRecheck,
      true
    );
    return record;
  } finally {
    releaseLock(lock);
  }
};

export const resolvePublicAskDecision = (
  runDir: string,
  input: PublicAskDecisionResolutionInput
): PublicAskRecordV1 => {
  if (
    !(
      ASK_ID_PATTERN.test(input.askId) &&
      validBinding(input.binding) &&
      publicAskId(input.binding) === input.askId &&
      (input.intent === "approve" || input.intent === "reject") &&
      isCanonicalTime(input.resolvedAt)
    )
  ) {
    throw new Error("public ask decision resolution is invalid");
  }
  const responseId = publicAskDecisionResponseId(input.askId, input.intent);
  const lock = acquireLock(runDir);
  try {
    const path = journalPath(runDir);
    const text = readSafeFile(path, MAX_PUBLIC_ASK_JOURNAL_BYTES);
    const records = parseJournalText(text);
    const current = records.find((record) => record.id === input.askId);
    if (
      !current ||
      current.kind !== "approval" ||
      JSON.stringify(current.binding) !== JSON.stringify(input.binding)
    ) {
      throw new Error("public ask decision resolution is unavailable");
    }
    if (current.state === "resolved") {
      if (current.responseCorrelation?.responseId !== responseId) {
        throw new Error("public ask decision resolution conflicts");
      }
      return current;
    }
    if (Date.parse(input.resolvedAt) <= Date.parse(current.updatedAt)) {
      throw new Error("public ask decision resolution is invalid");
    }
    const resolved: PublicAskRecordV1 = {
      ...current,
      responseCorrelation: { resolvedAt: input.resolvedAt, responseId },
      state: "resolved",
      updatedAt: input.resolvedAt,
    };
    appendRecord(runDir, text, resolved);
    return resolved;
  } finally {
    releaseLock(lock);
  }
};

export const resolvePublicAskAnswer = (
  runDir: string,
  input: PublicAskAnswerResolutionInput
): PublicAskRecordV1 => {
  if (
    !(
      ASK_ID_PATTERN.test(input.askId) &&
      validBinding(input.binding) &&
      publicAskId(input.binding) === input.askId &&
      typeof input.value === "string" &&
      input.value.length > 0 &&
      input.value.length <= 512 &&
      input.value.trim() === input.value &&
      !hasControlCharacter(input.value) &&
      isCanonicalTime(input.resolvedAt)
    )
  ) {
    throw new Error("public ask answer resolution is invalid");
  }
  const responseId = publicAskAnswerResponseId(input.askId, input.value);
  const lock = acquireLock(runDir);
  try {
    const path = journalPath(runDir);
    const text = readSafeFile(path, MAX_PUBLIC_ASK_JOURNAL_BYTES);
    const records = parseJournalText(text);
    const current = records.find((record) => record.id === input.askId);
    if (
      !current ||
      current.kind !== "question" ||
      JSON.stringify(current.binding) !== JSON.stringify(input.binding)
    ) {
      throw new Error("public ask answer resolution is unavailable");
    }
    if (current.state === "resolved") {
      if (current.responseCorrelation?.responseId !== responseId) {
        throw new Error("public ask answer resolution conflicts");
      }
      return current;
    }
    if (Date.parse(input.resolvedAt) <= Date.parse(current.updatedAt)) {
      throw new Error("public ask answer resolution is invalid");
    }
    const resolved: PublicAskRecordV1 = {
      ...current,
      responseCorrelation: { resolvedAt: input.resolvedAt, responseId },
      state: "resolved",
      updatedAt: input.resolvedAt,
    };
    appendRecord(runDir, text, resolved);
    return resolved;
  } finally {
    releaseLock(lock);
  }
};
