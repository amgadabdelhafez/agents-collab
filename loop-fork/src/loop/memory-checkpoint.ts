import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "bun";
import { readPendingBridgeMessages } from "./bridge-store";
import { readNativeFallbackRequests } from "./native-subagent";
import { readRunManifest } from "./run-state";
import type { Agent } from "./types";
import { readUtilityJobsForObservability } from "./utility-store";

export const MEMORY_CHECKPOINT_SCHEMA_VERSION = 1;
export const MEMORY_PROMOTION_SCHEMA_VERSION = 1;
export const MEMORY_PROMOTE_SUBCOMMAND = "__memory-promote";

export type MemoryCheckpointTrigger = "pre-compact" | "pre-turn";
export type MemoryPromotionClass =
  | "capability-boundary"
  | "explicit-user-preference"
  | "reusable-runbook"
  | "stable-decision"
  | "verified-incident";

export interface MemorySourceCursor {
  bytes: number;
  path: string;
  rows: number;
  sha256: string;
}

export interface MemoryCheckpoint {
  agent: Agent;
  blockers: string[];
  checkpointId: string;
  commitSha: string;
  createdAt: string;
  driverLease?: { epoch: number; expiresAt: string; holder: Agent };
  governessEpoch: number;
  nativeLeases: Array<{
    leaseId?: string;
    provider?: Agent;
    requestId: string;
    state: string;
  }>;
  objective?: string;
  pendingBridge: Array<{
    at: string;
    id: string;
    priority: string;
    source: string;
    subject?: string;
    target: Agent;
    type: string;
  }>;
  repoId: string;
  runDir: string;
  runId: string;
  schemaVersion: number;
  sessionRef: string;
  source: MemorySourceCursor;
  trigger: MemoryCheckpointTrigger;
  utilityJobs: Array<{
    jobId: string;
    requester: Agent;
    state: string;
    tier?: string;
    updatedAt: string;
  }>;
  workspace: { branchRef?: string; root: string };
}

export interface MemoryPromotion {
  checkpointId: string;
  class: MemoryPromotionClass;
  createdAt: string;
  curator: string;
  markdownPath: string;
  promotionId: string;
  schemaVersion: number;
  sourceSha256: string;
  title: string;
}

interface CheckpointInput {
  agent: Agent;
  at: string;
  hookFile: string;
  payload: unknown;
}

interface PromotionInput {
  body: string;
  checkpointPath: string;
  class: string;
  curator: string;
  outputDir: string;
  title: string;
}

const PROMOTION_CLASSES = new Set<MemoryPromotionClass>([
  "capability-boundary",
  "explicit-user-preference",
  "reusable-runbook",
  "stable-decision",
  "verified-incident",
]);
const TRANSIENT_PROMOTION_RE =
  /\b(?:maybe|might|probably|todo|in progress|currently working|unverified|hypothesis|pending review)\b/iu;
const SECRET_RE =
  /(?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*[^\s,;]+/giu;
const PEM_RE =
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu;
const SECRET_SEPARATOR_RE = /[:=]/u;
const MAX_OBJECTIVE_LENGTH = 1200;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const firstString = (
  value: Record<string, unknown>,
  keys: string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
};

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

export const redactMemoryText = (value: string): string =>
  value
    .replace(PEM_RE, "[REDACTED_PRIVATE_KEY]")
    .replace(
      SECRET_RE,
      (match) => `${match.split(SECRET_SEPARATOR_RE)[0]}=[REDACTED]`
    )
    .slice(0, MAX_OBJECTIVE_LENGTH);

const readSourceCursor = (hookFile: string): MemorySourceCursor => {
  try {
    const raw = readFileSync(hookFile);
    return {
      bytes: raw.byteLength,
      path: resolve(hookFile),
      rows: raw.toString("utf8").split("\n").filter(Boolean).length,
      sha256: sha256(raw),
    };
  } catch {
    return {
      bytes: 0,
      path: resolve(hookFile),
      rows: 0,
      sha256: sha256(""),
    };
  }
};

const readJson = (path: string): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
};

const gitHead = (root: string): string => {
  const result = spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stderr: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    return "unknown";
  }
  return result.stdout.toString().trim() || "unknown";
};

const atomicWrite = (path: string, body: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, body, "utf8");
  renameSync(temporary, path);
};

const checkpointTrigger = (
  agent: Agent,
  payload: Record<string, unknown>
): MemoryCheckpointTrigger | undefined => {
  const event = firstString(payload, [
    "hook_event_name",
    "hookEventName",
    "event",
    "type",
  ]);
  if (agent === "claude" && event === "PreCompact") {
    return "pre-compact";
  }
  if (agent === "codex" && event === "UserPromptSubmit") {
    return "pre-turn";
  }
  return undefined;
};

const checkpointBoundaryKey = (
  agent: Agent,
  trigger: MemoryCheckpointTrigger,
  payload: Record<string, unknown>,
  runId: string
): string => {
  const providerBoundary = firstString(payload, [
    "event_id",
    "eventId",
    "turn_id",
    "turnId",
    "compact_id",
    "compactId",
  ]);
  const sessionRef = firstString(payload, [
    "session_id",
    "sessionId",
    "thread_id",
    "threadId",
  ]);
  const objective = firstString(payload, [
    "prompt",
    "user_prompt",
    "userPrompt",
    "message",
  ]);
  return sha256(
    JSON.stringify({
      agent,
      objective: objective ? redactMemoryText(objective) : undefined,
      providerBoundary,
      runId,
      sessionRef,
      trigger,
    })
  ).slice(0, 24);
};

export const writeMemoryCheckpoint = (
  input: CheckpointInput
): MemoryCheckpoint | undefined => {
  const payload = asRecord(input.payload);
  const trigger = checkpointTrigger(input.agent, payload);
  if (!trigger) {
    return undefined;
  }
  const runDir = dirname(dirname(input.hookFile));
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  if (!manifest?.workspaceBinding?.root) {
    return undefined;
  }
  const sessionRef =
    firstString(payload, [
      "session_id",
      "sessionId",
      "thread_id",
      "threadId",
    ]) ??
    (input.agent === "claude"
      ? manifest.claudeSessionId
      : manifest.codexThreadId);
  if (!sessionRef) {
    return undefined;
  }
  const state = readJson(join(runDir, "governess-state.json"));
  const governessEpoch =
    typeof state.governessEpoch === "number" ? state.governessEpoch : 0;
  const objective = firstString(payload, [
    "prompt",
    "user_prompt",
    "userPrompt",
    "message",
  ]);
  const checkpointId = checkpointBoundaryKey(
    input.agent,
    trigger,
    payload,
    manifest.runId
  );
  const checkpoint: MemoryCheckpoint = {
    agent: input.agent,
    blockers: [],
    checkpointId,
    commitSha: gitHead(manifest.workspaceBinding.root),
    createdAt: input.at,
    ...(state.driverLease && typeof state.driverLease === "object"
      ? {
          driverLease: state.driverLease as MemoryCheckpoint["driverLease"],
        }
      : {}),
    governessEpoch,
    nativeLeases: readNativeFallbackRequests(runDir)
      .filter((lease) =>
        ["granted", "consumed", "running"].includes(lease.state)
      )
      .map((lease) => ({
        ...(lease.leaseId ? { leaseId: lease.leaseId } : {}),
        ...(lease.provider ? { provider: lease.provider } : {}),
        requestId: lease.request.id ?? "unknown",
        state: lease.state,
      })),
    ...(objective ? { objective: redactMemoryText(objective) } : {}),
    pendingBridge: readPendingBridgeMessages(runDir).map((message) => ({
      at: message.at,
      id: message.id,
      priority: message.priority ?? "normal",
      source: message.source,
      ...(message.subject ? { subject: message.subject } : {}),
      target: message.target,
      type: message.type ?? "message",
    })),
    repoId: manifest.repoId,
    runDir: resolve(runDir),
    runId: manifest.runId,
    schemaVersion: MEMORY_CHECKPOINT_SCHEMA_VERSION,
    sessionRef,
    source: readSourceCursor(input.hookFile),
    trigger,
    utilityJobs: readUtilityJobsForObservability(runDir)
      .filter(
        (job) =>
          !["completed", "failed", "escalated", "canceled"].includes(job.state)
      )
      .map((job) => ({
        jobId: job.jobId,
        requester: job.request.requester,
        state: job.state,
        ...(job.decision?.tierId ? { tier: job.decision.tierId } : {}),
        updatedAt: job.updatedAt,
      })),
    workspace: {
      ...(manifest.workspaceBinding.branchRef
        ? { branchRef: manifest.workspaceBinding.branchRef }
        : {}),
      root: resolve(manifest.workspaceBinding.root),
    },
  };
  const directory = join(runDir, "memory", "checkpoints", input.agent);
  const checkpointPath = join(directory, `${checkpointId}.json`);
  const body = `${JSON.stringify(checkpoint, null, 2)}\n`;
  if (!existsSync(checkpointPath)) {
    atomicWrite(checkpointPath, body);
  }
  const latestPath = join(runDir, "memory", `latest-${input.agent}.json`);
  if (!existsSync(latestPath) || readFileSync(latestPath, "utf8") !== body) {
    atomicWrite(latestPath, body);
  }
  return checkpoint;
};

const safeSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);

export const promoteMemoryCheckpoint = (
  input: PromotionInput
): MemoryPromotion => {
  if (!PROMOTION_CLASSES.has(input.class as MemoryPromotionClass)) {
    throw new Error(
      `memory promotion class is not allowlisted: ${input.class}`
    );
  }
  const title = input.title.trim();
  const curator = input.curator.trim();
  const body = redactMemoryText(input.body.trim());
  if (!(title && curator && body)) {
    throw new Error("memory promotion requires title, curator, and body");
  }
  if (TRANSIENT_PROMOTION_RE.test(body)) {
    throw new Error("memory promotion rejects transient or unverified claims");
  }
  const checkpointRaw = readFileSync(input.checkpointPath, "utf8");
  const checkpoint = JSON.parse(checkpointRaw) as MemoryCheckpoint;
  if (
    checkpoint.schemaVersion !== MEMORY_CHECKPOINT_SCHEMA_VERSION ||
    !(checkpoint.checkpointId && checkpoint.repoId && checkpoint.commitSha) ||
    checkpoint.commitSha === "unknown" ||
    !(checkpoint.source?.path && checkpoint.source.sha256)
  ) {
    throw new Error("memory promotion requires a valid, verified checkpoint");
  }
  if (statSync(input.checkpointPath).isDirectory()) {
    throw new Error("memory promotion checkpoint must be a file");
  }
  const promotionId = sha256(
    JSON.stringify({
      body,
      checkpointId: checkpoint.checkpointId,
      class: input.class,
      curator,
      title,
    })
  ).slice(0, 24);
  const markdownPath = join(
    resolve(input.outputDir),
    `${safeSlug(title) || promotionId}.md`
  );
  const markdown = `---\nschemaVersion: ${MEMORY_PROMOTION_SCHEMA_VERSION}\npromotionId: ${promotionId}\nclass: ${input.class}\ncheckpointId: ${checkpoint.checkpointId}\nsourceSha256: ${sha256(checkpointRaw)}\nrepoId: ${checkpoint.repoId}\ncommitSha: ${checkpoint.commitSha}\ncurator: ${JSON.stringify(curator)}\n---\n\n# ${title}\n\n${body}\n`;
  atomicWrite(markdownPath, markdown);
  const promotion: MemoryPromotion = {
    checkpointId: checkpoint.checkpointId,
    class: input.class as MemoryPromotionClass,
    createdAt: new Date().toISOString(),
    curator,
    markdownPath,
    promotionId,
    schemaVersion: MEMORY_PROMOTION_SCHEMA_VERSION,
    sourceSha256: sha256(checkpointRaw),
    title,
  };
  atomicWrite(
    join(resolve(input.outputDir), `${promotionId}.json`),
    `${JSON.stringify(promotion, null, 2)}\n`
  );
  return promotion;
};
