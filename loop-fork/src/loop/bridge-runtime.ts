import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { spawn, spawnSync } from "bun";
import { removeClaudeChannelServer } from "./bridge-claude-registration";
import { generatedClaudeChannelServerNames } from "./bridge-config";
import {
  BRIDGE_WORKER_SUBCOMMAND,
  CLAUDE_CHANNEL_USER,
} from "./bridge-constants";
import {
  acknowledgeBridgeDelivery,
  bridgeChatId,
  readNextPendingBridgeMessageForTarget,
} from "./bridge-dispatch";
import { formatBridgeDeliveryMessage } from "./bridge-message-format";
import {
  type BridgeMessage,
  type BridgeStatus,
  lastBridgeNotificationAt,
  markBridgeMessageNotified,
  readBridgeInbox,
  readBridgeStatus,
  readPendingBridgeMessages,
} from "./bridge-store";
import { injectCodexMessage } from "./codex-app-server";
import { buildLaunchArgv } from "./launch";
import { DETACH_CHILD_PROCESS } from "./process";
import {
  isActiveRunState,
  parseRunLifecycleState,
  readRunManifest,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import {
  boundedTmuxOptions,
  type TmuxLiveness,
  tmuxCommandTimedOut,
  tmuxSessionLiveness,
} from "./tmux-control";

const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";
const CLAUDE_CHANNEL_SOURCE_TYPE = "codex";
const CLAUDE_CHANNEL_USER_ID = "codex";
const BRIDGE_WORKER_FILE = "bridge-worker.json";
const BRIDGE_DELIVERY_CLAIM_DIR = "bridge-delivery-claims";
const BRIDGE_NOTIFICATION_CLAIM_DIR = "bridge-notification-claims";
// App-server acceptance can outlive a normal bridge-worker tick. Keep a claim
// long enough that another worker cannot duplicate the same Codex turn.
const BRIDGE_DELIVERY_CLAIM_STALE_MS = 60_000;
const BRIDGE_NOTIFICATION_CLAIM_STALE_MS = 15_000;
const BRIDGE_WORKER_IDLE_DELAY_MS = 250;
const BRIDGE_WORKER_SUCCESS_DELAY_MS = 100;
const BRIDGE_NOTIFICATION_RETRY_MS = 30_000;
const TMUX_LEFT_PANE = "0.0";
const TMUX_RIGHT_PANE = "0.1";
const CODEX_TMUX_READY_DELAY_MS = 250;
const CODEX_TMUX_READY_POLLS = 20;
const CODEX_TMUX_SEND_FOOTER = "Ctrl+J newline";
const CODEX_TMUX_PROMPT_PREFIX = "› ";
const CODEX_TMUX_FOOTER_SEPARATOR = " · ";
const CODEX_TMUX_READY_TAIL_LINES = 8;
const CLAUDE_TMUX_PROMPT_PREFIX = "❯";
const LINE_SPLIT_RE = /\r?\n/;
const GENERIC_TMUX_READY_POLLS = 12;
const CLAUDE_DELIVERY_CONFIRM_POLLS = 8;
const MAX_TMUX_BRIDGE_NUDGE_BYTES = 128;
const TUI_PASTE_MARKER_RE = /\[Pasted (?:Content|text)\b[^\]]*\]/i;
const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const containedRegularFile = (
  root: string,
  candidate: string
): string | undefined => {
  try {
    if (!lstatSync(candidate).isFile()) {
      return undefined;
    }
    const canonicalRoot = realpathSync(root);
    const canonical = realpathSync(candidate);
    const rel = relative(canonicalRoot, canonical);
    return rel === "" || !(rel.startsWith("..") || isAbsolute(rel))
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
};

const claudeTranscriptPath = (
  runDir: string,
  projectsDir: string
): string | undefined => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  if (
    !(
      manifest?.claudeSessionId &&
      manifest.cwd &&
      CLAUDE_SESSION_ID_RE.test(manifest.claudeSessionId)
    )
  ) {
    return undefined;
  }
  const filename = `${manifest.claudeSessionId}.jsonl`;
  const projectKey = manifest.cwd.replaceAll("/", "-");
  if (projectKey !== "." && projectKey !== "..") {
    const candidate = containedRegularFile(
      projectsDir,
      join(projectsDir, projectKey, filename)
    );
    if (candidate) {
      return candidate;
    }
  }
  try {
    for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!project.isDirectory()) {
        continue;
      }
      const path = containedRegularFile(
        projectsDir,
        join(projectsDir, project.name, filename)
      );
      if (path) {
        return path;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const readClaudeTranscriptVersionFromProjects = (
  runDir: string,
  projectsDir: string
): string | undefined => {
  const path = claudeTranscriptPath(runDir, projectsDir);
  if (!path) {
    return undefined;
  }
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
};

const fileVersion = (path: string): string | undefined => {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
};

export const readClaudeSubmissionVersion = (
  runDir: string,
  projectsDir = join(homedir(), ".claude", "projects")
): string | undefined => {
  const transcript = readClaudeTranscriptVersionFromProjects(
    runDir,
    projectsDir
  );
  const hookJournal = fileVersion(join(runDir, "hooks", "claude.jsonl"));
  return transcript || hookJournal
    ? `transcript=${transcript ?? "-"};hook=${hookJournal ?? "-"}`
    : undefined;
};

const readClaudeTranscriptVersion = (runDir: string): string | undefined =>
  readClaudeSubmissionVersion(runDir);

export const bridgeRuntimeCommandDeps = {
  readClaudeTranscriptVersion,
  spawn,
  spawnSync,
};

const bridgeWorkerPath = (runDir: string): string =>
  join(runDir, BRIDGE_WORKER_FILE);

const readBridgeWorkerPid = (runDir: string): number | undefined => {
  const path = bridgeWorkerPath(runDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      Number.isInteger((parsed as { pid: number }).pid) &&
      (parsed as { pid: number }).pid > 0
    ) {
      return (parsed as { pid: number }).pid;
    }
  } catch {
    // ignore malformed worker state
  }
  return undefined;
};

const writeBridgeWorkerPid = (runDir: string, pid: number): void => {
  writeFileSync(
    bridgeWorkerPath(runDir),
    `${JSON.stringify({ pid })}\n`,
    "utf8"
  );
};

const clearBridgeWorkerPid = (runDir: string, pid?: number): void => {
  const current = readBridgeWorkerPid(runDir);
  if (pid !== undefined && current !== pid) {
    return;
  }
  rmSync(bridgeWorkerPath(runDir), { force: true });
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const deliveryClaimPath = (runDir: string, messageId: string): string => {
  const digest = createHash("sha256").update(messageId).digest("hex");
  return join(runDir, BRIDGE_DELIVERY_CLAIM_DIR, `${digest}.lock`);
};

const acquireRuntimeClaim = (
  path: string,
  staleMs: number,
  nowMs = Date.now()
): string | undefined => {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx");
      closeSync(fd);
      return path;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        return undefined;
      }
      try {
        if (nowMs - statSync(path).mtimeMs <= staleMs) {
          return undefined;
        }
        unlinkSync(path);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

const acquireDeliveryClaim = (
  runDir: string,
  messageId: string,
  nowMs = Date.now()
): string | undefined =>
  acquireRuntimeClaim(
    deliveryClaimPath(runDir, messageId),
    BRIDGE_DELIVERY_CLAIM_STALE_MS,
    nowMs
  );

const acquireNotificationClaim = (
  runDir: string,
  target: BridgeMessage["target"],
  nowMs: number
): string | undefined =>
  acquireRuntimeClaim(
    join(runDir, BRIDGE_NOTIFICATION_CLAIM_DIR, `${target}.lock`),
    BRIDGE_NOTIFICATION_CLAIM_STALE_MS,
    nowMs
  );

const releaseDeliveryClaim = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // A delivery claim is advisory runtime state; stale claims self-heal.
  }
};

export const isBridgeDeliveryClaimed = (
  runDir: string,
  messageId: string,
  nowMs = Date.now()
): boolean => {
  try {
    return (
      nowMs - statSync(deliveryClaimPath(runDir, messageId)).mtimeMs <=
      BRIDGE_DELIVERY_CLAIM_STALE_MS
    );
  } catch {
    return false;
  }
};

const decodeOutput = (value: Uint8Array): string =>
  new TextDecoder().decode(value);

// biome-ignore lint/suspicious/noControlCharactersInRegex: parses tmux -e SGR escapes
const SGR_SEQUENCE_RE = /\u001B\[([0-9;]*)m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips residual ANSI escapes
const ANSI_ESCAPE_RE = /\u001B\[[0-9;?]*[@-~]/g;

// Claude Code renders its idle type-ahead suggestion in SGR dim, so dim spans
// in a styled capture are ghost text, not a human draft.
const stripDimSpans = (line: string): string => {
  let dim = false;
  let plain = "";
  let cursor = 0;
  for (const match of line.matchAll(SGR_SEQUENCE_RE)) {
    if (!dim) {
      plain += line.slice(cursor, match.index);
    }
    cursor = (match.index ?? 0) + match[0].length;
    for (const code of (match[1] === "" ? "0" : match[1]).split(";")) {
      if (code === "2") {
        dim = true;
      } else if (code === "0" || code === "22") {
        dim = false;
      }
    }
  }
  if (!dim) {
    plain += line.slice(cursor);
  }
  return plain.replace(ANSI_ESCAPE_RE, "");
};

const tmuxPane = (session: string, paneId: string): string =>
  `${session}:${paneId}`;

const capturePane = (pane: string, styled = false): string | undefined => {
  try {
    const result = bridgeRuntimeCommandDeps.spawnSync(
      styled
        ? ["tmux", "capture-pane", "-p", "-e", "-t", pane]
        : ["tmux", "capture-pane", "-p", "-t", pane],
      boundedTmuxOptions({
        stderr: "ignore",
        stdout: "pipe",
      })
    );
    if (tmuxCommandTimedOut(result) || result.exitCode !== 0) {
      return undefined;
    }
    return decodeOutput(result.stdout);
  } catch {
    return undefined;
  }
};

const sendPaneKeys = (pane: string, keys: string[]): boolean => {
  try {
    const result = bridgeRuntimeCommandDeps.spawnSync(
      ["tmux", "send-keys", "-t", pane, ...keys],
      boundedTmuxOptions({
        stderr: "ignore",
      })
    );
    return !tmuxCommandTimedOut(result) && result.exitCode === 0;
  } catch {
    return false;
  }
};

const sendPaneText = (pane: string, text: string): boolean => {
  try {
    const result = bridgeRuntimeCommandDeps.spawnSync(
      ["tmux", "send-keys", "-t", pane, "-l", "--", text],
      boundedTmuxOptions({
        stderr: "ignore",
      })
    );
    return !tmuxCommandTimedOut(result) && result.exitCode === 0;
  } catch {
    return false;
  }
};

const pastePaneText = (runDir: string, pane: string, text: string): boolean => {
  const id = randomUUID();
  const buffer = `loop-bridge-${id}`;
  const path = join(runDir, `.bridge-paste-${id}.txt`);
  let bufferLoaded = false;
  try {
    writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const loaded = bridgeRuntimeCommandDeps.spawnSync(
      ["tmux", "load-buffer", "-b", buffer, path],
      boundedTmuxOptions({ stderr: "ignore" })
    );
    if (tmuxCommandTimedOut(loaded) || loaded.exitCode !== 0) {
      return false;
    }
    bufferLoaded = true;
    const pasted = bridgeRuntimeCommandDeps.spawnSync(
      ["tmux", "paste-buffer", "-d", "-p", "-b", buffer, "-t", pane],
      boundedTmuxOptions({ stderr: "ignore" })
    );
    if (tmuxCommandTimedOut(pasted) || pasted.exitCode !== 0) {
      return false;
    }
    bufferLoaded = false;
    return true;
  } catch {
    return false;
  } finally {
    rmSync(path, { force: true });
    if (bufferLoaded) {
      try {
        bridgeRuntimeCommandDeps.spawnSync(
          ["tmux", "delete-buffer", "-b", buffer],
          boundedTmuxOptions({ stderr: "ignore" })
        );
      } catch {
        // The delivery remains unacknowledged; a stale tmux buffer is inert.
      }
    }
  }
};

const isCodexPaneReady = (output: string): boolean => {
  if (output.includes(CODEX_TMUX_SEND_FOOTER)) {
    return true;
  }
  const tail = output.split(LINE_SPLIT_RE).slice(-CODEX_TMUX_READY_TAIL_LINES);
  const promptIndex = tail.findIndex((line) =>
    line.trimStart().startsWith(CODEX_TMUX_PROMPT_PREFIX)
  );
  return (
    promptIndex >= 0 &&
    tail
      .slice(promptIndex + 1)
      .some((line) => line.includes(CODEX_TMUX_FOOTER_SEPARATOR))
  );
};

const waitForCodexPane = async (
  pane: string,
  attempts = CODEX_TMUX_READY_POLLS
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = capturePane(pane);
    if (output === undefined) {
      return false;
    }
    if (isCodexPaneReady(output)) {
      return true;
    }
    await wait(CODEX_TMUX_READY_DELAY_MS);
  }
  return false;
};

const claudeComposerText = (output: string): string | undefined => {
  const prompt = output
    .split(LINE_SPLIT_RE)
    .slice(-CODEX_TMUX_READY_TAIL_LINES)
    .map(stripDimSpans)
    .findLast((line) => line.trimStart().startsWith(CLAUDE_TMUX_PROMPT_PREFIX));
  return prompt?.trimStart().slice(CLAUDE_TMUX_PROMPT_PREFIX.length).trim();
};

export const isClaudePaneReady = (output: string): boolean =>
  claudeComposerText(output) === "";

export const isClaudeTurnActive = (runDir: string): boolean => {
  try {
    const latest = readFileSync(join(runDir, "hooks", "claude.jsonl"), "utf8")
      .split(LINE_SPLIT_RE)
      .filter((line) => line.trim())
      .findLast((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      });
    if (!latest) {
      return false;
    }
    const event = JSON.parse(latest) as { event?: unknown; state?: unknown };
    if (event.state === "starting" || event.state === "working") {
      return true;
    }
    return (
      event.state === undefined &&
      (event.event === "SessionStart" ||
        event.event === "UserPromptSubmit" ||
        event.event === "PreToolUse" ||
        event.event === "PostToolUse")
    );
  } catch {
    return false;
  }
};

type ClaudeSubmissionState =
  | "confirmed"
  | "foreign-draft"
  | "stranded"
  | "unknown";

const confirmClaudeSubmission = async (
  runDir: string,
  pane: string,
  previousTranscriptVersion: string | undefined,
  expectedComposerText: string
): Promise<ClaudeSubmissionState> => {
  let sawStrandedComposer = false;
  for (let attempt = 0; attempt < CLAUDE_DELIVERY_CONFIRM_POLLS; attempt += 1) {
    const output = capturePane(pane, true);
    if (output === undefined) {
      return "unknown";
    }
    const composer = claudeComposerText(output);
    const transcriptVersion =
      bridgeRuntimeCommandDeps.readClaudeTranscriptVersion(runDir);
    if (
      transcriptVersion !== undefined &&
      transcriptVersion !== previousTranscriptVersion &&
      !composer
    ) {
      return "confirmed";
    }
    if (composer) {
      if (
        composer === expectedComposerText ||
        TUI_PASTE_MARKER_RE.test(composer)
      ) {
        sawStrandedComposer = true;
      } else {
        return "foreign-draft";
      }
    }
    await wait(CODEX_TMUX_READY_DELAY_MS);
  }
  return sawStrandedComposer ? "stranded" : "unknown";
};

const waitForClaudePane = async (
  runDir: string,
  pane: string,
  attempts = GENERIC_TMUX_READY_POLLS
): Promise<boolean> => {
  if (isClaudeTurnActive(runDir)) {
    return false;
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = capturePane(pane, true);
    if (output === undefined) {
      return false;
    }
    if (!isClaudeTurnActive(runDir) && isClaudePaneReady(output)) {
      return true;
    }
    await wait(CODEX_TMUX_READY_DELAY_MS);
  }
  return false;
};

const waitForInteractivePane = async (
  pane: string,
  attempts = GENERIC_TMUX_READY_POLLS
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const output = capturePane(pane);
    if (output === undefined) {
      return false;
    }
    if (output.trim()) {
      return true;
    }
    await wait(CODEX_TMUX_READY_DELAY_MS);
  }
  return true;
};

const waitForBridgePaneReady = (
  runDir: string,
  pane: string,
  target: BridgeMessage["target"],
  attempts?: number
): Promise<boolean> => {
  if (target === "codex") {
    return waitForCodexPane(pane, attempts);
  }
  if (target === "claude") {
    return waitForClaudePane(runDir, pane, attempts);
  }
  return waitForInteractivePane(pane, attempts);
};

const injectTmuxMessage = async (
  runDir: string,
  pane: string,
  target: BridgeMessage["target"],
  message: string,
  readyAttempts?: number
): Promise<boolean> => {
  const ready = await waitForBridgePaneReady(
    runDir,
    pane,
    target,
    readyAttempts
  );
  if (!(pane && ready)) {
    return false;
  }
  if (Buffer.byteLength(message, "utf8") >= MAX_TMUX_BRIDGE_NUDGE_BYTES) {
    return false;
  }
  const transcriptVersion =
    target === "claude"
      ? bridgeRuntimeCommandDeps.readClaudeTranscriptVersion(runDir)
      : undefined;
  const expectedClaudeComposerText = message.split("\n")[0]?.trim() ?? "";
  if (!pastePaneText(runDir, pane, message)) {
    return false;
  }
  if (!sendPaneKeys(pane, ["Enter"])) {
    return false;
  }
  if (target !== "claude") {
    return true;
  }
  const firstConfirmation = await confirmClaudeSubmission(
    runDir,
    pane,
    transcriptVersion,
    expectedClaudeComposerText
  );
  if (firstConfirmation === "confirmed") {
    return true;
  }
  if (firstConfirmation !== "stranded" || !sendPaneText(pane, " ")) {
    return false;
  }
  await wait(100);
  if (!sendPaneKeys(pane, ["Enter"])) {
    return false;
  }
  return (
    (await confirmClaudeSubmission(
      runDir,
      pane,
      transcriptVersion,
      expectedClaudeComposerText
    )) === "confirmed"
  );
};

export interface BridgeRuntimeStatus extends BridgeStatus {
  codexDeliveryMode: "app-server" | "none" | "tmux";
  hasLiveTmuxSession: boolean;
  tmuxLiveness: TmuxLiveness;
}

const readRunManifestForBridge = (runDir: string) =>
  readRunManifest(join(runDir, "manifest.json"));

const paneIdForTarget = (
  runDir: string,
  target: BridgeMessage["target"]
): string | undefined => {
  const manifest = readRunManifestForBridge(runDir);
  if (manifest?.tmuxPaneLeftAgent === target) {
    return TMUX_LEFT_PANE;
  }
  if (manifest?.tmuxPaneRightAgent === target) {
    return TMUX_RIGHT_PANE;
  }
  if (manifest?.tmuxPaneLeftAgent || manifest?.tmuxPaneRightAgent) {
    return undefined;
  }
  if (target === "codex") {
    return TMUX_RIGHT_PANE;
  }
  if (target === "claude") {
    return TMUX_LEFT_PANE;
  }
  return undefined;
};

const tmuxPaneForTarget = (
  runDir: string,
  target: BridgeMessage["target"]
): string | undefined => {
  const manifest = readRunManifestForBridge(runDir);
  if (!manifest?.tmuxSession) {
    return undefined;
  }
  if (manifest.tmuxPaneLeftAgent === target && manifest.tmuxPaneLeft) {
    return manifest.tmuxPaneLeft;
  }
  if (manifest.tmuxPaneRightAgent === target && manifest.tmuxPaneRight) {
    return manifest.tmuxPaneRight;
  }
  const paneId = paneIdForTarget(runDir, target);
  return paneId ? tmuxPane(manifest.tmuxSession, paneId) : undefined;
};

export const buildTmuxBridgeNudge = (pending: number): string =>
  `Bridge: ${pending} ${pending === 1 ? "message" : "messages"} waiting. Call receive_messages now.`;

export const readBridgeRuntimeStatus = (
  runDir: string
): BridgeRuntimeStatus => {
  const status = readBridgeStatus(runDir);
  const tmuxLiveness = status.tmuxSession
    ? tmuxSessionLiveness(
        status.tmuxSession,
        bridgeRuntimeCommandDeps.spawnSync
      )
    : "dead";
  const hasLiveTmuxSession = tmuxLiveness === "live";
  let codexDeliveryMode: BridgeRuntimeStatus["codexDeliveryMode"] = "none";
  if (status.hasCodexRemote) {
    codexDeliveryMode = "app-server";
  } else if (hasLiveTmuxSession) {
    codexDeliveryMode = "tmux";
  }
  return {
    ...status,
    codexDeliveryMode,
    hasLiveTmuxSession,
    tmuxLiveness,
  };
};

export const ensureBridgeWorker = (runDir: string): boolean => {
  const status = readBridgeStatus(runDir);
  const state = parseRunLifecycleState(status.state);
  if (
    !(
      (status.hasCodexRemote || status.hasTmuxSession) &&
      state &&
      isActiveRunState(state)
    )
  ) {
    return false;
  }
  const currentPid = readBridgeWorkerPid(runDir);
  if (currentPid && isProcessAlive(currentPid)) {
    return true;
  }
  clearBridgeWorkerPid(runDir);
  try {
    const child = bridgeRuntimeCommandDeps.spawn(
      [...buildLaunchArgv(), BRIDGE_WORKER_SUBCOMMAND, runDir],
      {
        detached: DETACH_CHILD_PROCESS,
        env: process.env,
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
      }
    );
    if (!(typeof child.pid === "number" && child.pid > 0)) {
      return false;
    }
    writeBridgeWorkerPid(runDir, child.pid);
    child.unref?.();
    return true;
  } catch {
    return false;
  }
};

export const hasLiveCodexTmuxSession = (runDir: string): boolean => {
  const manifest = readRunManifest(join(runDir, "manifest.json"));
  return Boolean(
    manifest?.tmuxSession &&
      tmuxSessionLiveness(
        manifest.tmuxSession,
        bridgeRuntimeCommandDeps.spawnSync
      ) === "live"
  );
};

export const hasBridgeDeliveryRoute = (
  runDir: string,
  target: BridgeMessage["target"]
): boolean => {
  const status = readBridgeStatus(runDir);
  if (target === "codex" && status.hasCodexRemote) {
    return true;
  }
  return Boolean(status.hasTmuxSession && paneIdForTarget(runDir, target));
};

export const clearStaleTmuxBridgeState = (runDir: string): boolean => {
  let removedServerNames: string[] = [];
  const next = updateRunManifest(join(runDir, "manifest.json"), (manifest) => {
    if (!manifest?.tmuxSession) {
      return manifest;
    }
    removedServerNames = [
      manifest.claudeChannelServer,
      ...generatedClaudeChannelServerNames(manifest.runId, manifest.repoId),
    ].filter((name): name is string => Boolean(name));
    return touchRunManifest(
      {
        ...manifest,
        tmuxSession: undefined,
        tmuxPaneLeftAgent: undefined,
        tmuxPaneRightAgent: undefined,
      },
      new Date().toISOString()
    );
  });
  if (!(next && removedServerNames.length > 0)) {
    return false;
  }
  for (const serverName of new Set(removedServerNames)) {
    removeClaudeChannelServer(
      serverName,
      (args) =>
        bridgeRuntimeCommandDeps.spawnSync(args, {
          stderr: "pipe",
          stdout: "ignore",
        }),
      console.error
    );
  }
  return true;
};

const writeChannelNotification = (
  runDir: string,
  message: BridgeMessage,
  writeJsonRpc: (payload: unknown) => void
): void => {
  writeJsonRpc({
    jsonrpc: "2.0",
    method: CLAUDE_CHANNEL_METHOD,
    params: {
      content: message.message,
      meta: {
        chat_id: bridgeChatId(runDir),
        message_id: message.id,
        source_type: CLAUDE_CHANNEL_SOURCE_TYPE,
        ts: new Date(message.at).toISOString(),
        user: CLAUDE_CHANNEL_USER,
        user_id: CLAUDE_CHANNEL_USER_ID,
      },
    },
  });
};

export const flushClaudeChannelMessages = (
  runDir: string,
  writeJsonRpc: (payload: unknown) => void
): void => {
  const status = readBridgeRuntimeStatus(runDir);
  if (
    status.tmuxLiveness !== "dead" &&
    tmuxPaneForTarget(runDir, "claude") !== undefined
  ) {
    return;
  }
  for (const message of readBridgeInbox(runDir, "claude")) {
    writeChannelNotification(runDir, message, writeJsonRpc);
    acknowledgeBridgeDelivery(runDir, message);
  }
};

export const deliverCodexBridgeMessage = async (
  runDir: string,
  message: BridgeMessage
): Promise<boolean> => {
  const status = readBridgeStatus(runDir);
  if (!status.hasCodexRemote) {
    return false;
  }
  if (!isMessagePending(runDir, message.id)) {
    return false;
  }
  const claim = acquireDeliveryClaim(runDir, message.id);
  if (!claim) {
    return false;
  }
  try {
    if (!isMessagePending(runDir, message.id)) {
      return false;
    }
    const delivered = await injectCodexMessage(
      status.codexRemoteUrl,
      status.codexThreadId,
      formatBridgeDeliveryMessage(message)
    );
    if (delivered) {
      acknowledgeBridgeDelivery(
        runDir,
        message,
        "accepted by codex app-server"
      );
    }
    return delivered;
  } catch {
    return false;
  } finally {
    releaseDeliveryClaim(claim);
  }
};

const resolveTmuxBridgeDelivery = (
  runDir: string,
  target: BridgeMessage["target"],
  pending: number
): { content: string; pane: string } | undefined => {
  const status = readBridgeRuntimeStatus(runDir);
  if (!status.tmuxSession) {
    return undefined;
  }
  if (status.tmuxLiveness === "dead") {
    clearStaleTmuxBridgeState(runDir);
    return undefined;
  }
  if (status.tmuxLiveness === "unknown") {
    return undefined;
  }
  const pane = tmuxPaneForTarget(runDir, target);
  const content = buildTmuxBridgeNudge(pending);
  return pane && content ? { content, pane } : undefined;
};

export const submitTmuxBridgeMessage = (
  runDir: string,
  message: BridgeMessage,
  readyAttempts?: number
): Promise<boolean> => {
  return notifyTmuxBridgeInbox(
    runDir,
    message.target,
    Date.now(),
    readyAttempts
  );
};

const isMessagePending = (runDir: string, messageId: string): boolean =>
  readPendingBridgeMessages(runDir).some((entry) => entry.id === messageId);

export const notifyTmuxBridgeInbox = async (
  runDir: string,
  target: BridgeMessage["target"],
  nowMs = Date.now(),
  readyAttempts?: number
): Promise<boolean> => {
  const pending = readPendingBridgeMessages(runDir, nowMs).filter(
    (entry) => entry.target === target
  );
  if (pending.length === 0) {
    return false;
  }
  const due = pending.some((entry) => {
    const notifiedAt = lastBridgeNotificationAt(runDir, entry.id);
    return (
      notifiedAt === undefined ||
      nowMs - notifiedAt >= BRIDGE_NOTIFICATION_RETRY_MS
    );
  });
  if (!due) {
    return false;
  }
  const claim = acquireNotificationClaim(runDir, target, nowMs);
  if (!claim) {
    return false;
  }
  try {
    const resolved = resolveTmuxBridgeDelivery(runDir, target, pending.length);
    if (!resolved) {
      return false;
    }
    if (!(await waitForBridgePaneReady(runDir, resolved.pane, target))) {
      return false;
    }
    const stillPending = readPendingBridgeMessages(runDir, nowMs).filter(
      (entry) => entry.target === target
    );
    if (stillPending.length === 0) {
      return false;
    }
    const notified = await injectTmuxMessage(
      runDir,
      resolved.pane,
      target,
      buildTmuxBridgeNudge(stillPending.length),
      readyAttempts ?? 1
    );
    if (!notified) {
      return false;
    }
    const at = new Date(nowMs).toISOString();
    for (const entry of stillPending) {
      markBridgeMessageNotified(
        runDir,
        entry,
        `nudged ${target} tmux inbox`,
        at
      );
    }
    return true;
  } finally {
    releaseDeliveryClaim(claim);
  }
};

export const deliverTmuxBridgeMessage = async (
  runDir: string,
  message: BridgeMessage
): Promise<boolean> => {
  if (!isMessagePending(runDir, message.id)) {
    return false;
  }
  await notifyTmuxBridgeInbox(runDir, message.target);
  // A terminal nudge is not delivery. The bridge message remains pending until
  // the target drains receive_messages, which appends the authoritative ack.
  return false;
};

export const drainCodexTmuxMessages = (runDir: string): Promise<boolean> => {
  const message = readNextPendingBridgeMessageForTarget(runDir, "codex");
  if (!message) {
    return Promise.resolve(false);
  }
  return notifyTmuxBridgeInbox(runDir, "codex");
};

export const drainCodexAppServerMessages = (
  runDir: string
): Promise<boolean> => {
  const status = readBridgeStatus(runDir);
  if (!status.hasCodexRemote) {
    return Promise.resolve(false);
  }
  const message = readNextPendingBridgeMessageForTarget(runDir, "codex");
  if (!message) {
    return Promise.resolve(false);
  }
  return deliverCodexBridgeMessage(runDir, message);
};

export const drainTmuxBridgeMessages = (runDir: string): Promise<boolean> => {
  const status = readBridgeRuntimeStatus(runDir);
  if (!status.tmuxSession) {
    return Promise.resolve(false);
  }
  if (status.tmuxLiveness === "dead") {
    clearStaleTmuxBridgeState(runDir);
    return Promise.resolve(false);
  }
  if (status.tmuxLiveness === "unknown") {
    return Promise.resolve(false);
  }
  const message = readPendingBridgeMessages(runDir).find(
    (entry) =>
      !(entry.target === "codex" && status.hasCodexRemote) &&
      paneIdForTarget(runDir, entry.target) !== undefined
  );
  if (!message) {
    return Promise.resolve(false);
  }
  return notifyTmuxBridgeInbox(runDir, message.target);
};

export const runBridgeWorker = async (runDir: string): Promise<void> => {
  try {
    while (true) {
      const claimedPid = readBridgeWorkerPid(runDir);
      if (claimedPid && claimedPid !== process.pid) {
        return;
      }
      const status = readBridgeStatus(runDir);
      const state = parseRunLifecycleState(status.state);
      if (!(state && isActiveRunState(state))) {
        return;
      }
      const deliveredToCodex =
        status.hasCodexRemote && (await drainCodexAppServerMessages(runDir));
      const delivered =
        deliveredToCodex || (await drainTmuxBridgeMessages(runDir));
      if (!(status.hasCodexRemote || status.hasTmuxSession)) {
        return;
      }
      await wait(
        delivered ? BRIDGE_WORKER_SUCCESS_DELAY_MS : BRIDGE_WORKER_IDLE_DELAY_MS
      );
    }
  } finally {
    clearBridgeWorkerPid(runDir, process.pid);
  }
};
