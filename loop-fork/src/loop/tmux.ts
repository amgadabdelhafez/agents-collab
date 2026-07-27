import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "bun";
import {
  registerClaudeChannelServer,
  removeClaudeChannelServer,
} from "./bridge-claude-registration";
import {
  buildClaudeChannelServerConfig,
  claudeChannelServerName,
  legacyClaudeChannelServerName,
  resolveClaudeChannelServerName,
} from "./bridge-config";
import {
  mandatoryUtilityDelegationGuidance,
  type BridgeTool,
  quotedBridgeTool,
  singleBridgeTransportGuidance,
} from "./bridge-guidance";
import { getCodexAppServerUrl, getLastCodexThreadId } from "./codex-app-server";
import { codexHomeEnv } from "./codex-home";
import {
  CODEX_TMUX_PROXY_SUBCOMMAND,
  findCodexTmuxProxyPort,
  waitForCodexTmuxProxy,
} from "./codex-tmux-proxy";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_CONFIG_VALUES } from "./constants";
import { buildLoopName, decode, runGit, sanitizeBase } from "./git";
import { GOVERNESS_SUBCOMMAND } from "./governess";
import {
  buildClaudeHookSettings,
  buildCodexHooksJson,
  buildHookCommand,
} from "./hooks/settings";
import { buildLaunchArgv } from "./launch";
import { withLegacyGovernessEnv } from "./legacy-governess-compat";
import { preparePairedRun } from "./paired-options";
import { DETACH_CHILD_PROCESS } from "./process";
import {
  SESSION_STATE_GUIDANCE,
  SPAWN_TEAM_WITH_WORKTREE_ISOLATION,
} from "./prompts";
import {
  type RunManifest,
  type RunStorage,
  resolveExistingRunId,
  touchRunManifest,
  updateRunManifest,
} from "./run-state";
import {
  closePersistentCodexSession,
  releasePersistentCodexSession,
  startPersistentAgentSession,
} from "./runner";
import type { Agent, Options } from "./types";
import { UTILITY_PANE_SUBCOMMAND } from "./utility-runtime";

export const TMUX_FLAG = "--tmux";
export const TMUX_MISSING_ERROR =
  "Error: tmux is not installed. Install tmux with: brew install tmux";
const WORKTREE_FLAG = "--worktree";
const RUN_ID_FLAG = "--run-id";
const SESSION_FLAG = "--session";
const ONLY_MODE_FLAGS = [
  "--claude-only",
  "--codex-only",
  "--copilot-only",
  "--cursor-only",
  "--gemini-only",
] as const;
const RUN_BASE_ENV = "LOOP_RUN_BASE";
const RUN_ID_ENV = "LOOP_RUN_ID";
const CLAUDE_TRUST_PROMPT = "Is this a project you created or one you trust?";
const CLAUDE_BYPASS_PROMPT = "running in Bypass Permissions mode";
const CLAUDE_BYPASS_MODE = "Bypass Permissions mode";
const CLAUDE_BYPASS_ACCEPT = "Yes, I accept";
const CLAUDE_EXIT_OPTION = "No, exit";
const CLAUDE_DEV_CHANNELS_PROMPT = "WARNING: Loading development channels";
const CLAUDE_DEV_CHANNELS_CONFIRM = "I am using this for local development";
const CLAUDE_PROMPT_MAX_POLLS = 8;
const CLAUDE_PROMPT_POLL_DELAY_MS = 250;
const CLAUDE_PROMPT_SETTLE_POLLS = 2;
const DEFAULT_UTILITY_PANE_WIDTH = "25%";
const UTILITY_PANE_WIDTH_RE = /^\d+%?$/;

interface SpawnResult {
  exitCode: number;
  stderr: string;
  stdout?: string;
}

interface TerminalSize {
  columns: number;
  rows: number;
}

interface GitResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

interface TmuxDeps {
  attach: (session: string) => void;
  capturePane: (pane: string) => string;
  closePersistentCodexSession: typeof closePersistentCodexSession;
  cwd: string;
  env: NodeJS.ProcessEnv;
  findBinary: (cmd: string) => boolean;
  getCodexAppServerUrl: () => string;
  getLastCodexThreadId: () => string;
  getTerminalSize: () => TerminalSize | undefined;
  isInteractive: () => boolean;
  launchArgv: string[];
  log: (line: string) => void;
  makeClaudeSessionId: () => string;
  preparePairedRun: typeof preparePairedRun;
  releasePersistentCodexSession: typeof releasePersistentCodexSession;
  runGit: (cwd: string, args: string[]) => GitResult;
  sendKeys: (pane: string, keys: string[]) => void;
  sendText: (pane: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  spawn: (args: string[]) => SpawnResult;
  startCodexProxy: (
    runDir: string,
    remoteUrl: string,
    threadId: string
  ) => Promise<string>;
  startPersistentAgentSession: typeof startPersistentAgentSession;
  updateRunManifest: typeof updateRunManifest;
}

interface PairedTmuxLaunch {
  opts: Options;
  task?: string;
}

const quoteShellArg = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

const buildShellCommand = (argv: string[]): string =>
  argv.map(quoteShellArg).join(" ");

const spawnDetachedProcess = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  spawnFn: typeof spawn = spawn
): void => {
  const child = spawnFn(argv, {
    detached: DETACH_CHILD_PROCESS,
    env,
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  child.unref?.();
};

const stripTmuxFlag = (argv: string[]): string[] =>
  argv.filter((arg) => arg !== TMUX_FLAG);

const isSingleAgentMode = (argv: string[]): boolean =>
  ONLY_MODE_FLAGS.some((flag) => argv.includes(flag));

const capitalize = (value: string): string =>
  value.slice(0, 1).toUpperCase() + value.slice(1);

const peerAgent = (agent: Agent, pairWith?: Agent): Agent => {
  if (pairWith) {
    return pairWith;
  }
  const peers: Record<Agent, Agent> = {
    claude: "codex",
    codex: "claude",
    copilot: "claude",
    cursor: "claude",
    gemini: "claude",
  };
  return peers[agent];
};

const pairedPeer = (opts: Options): Agent =>
  peerAgent(opts.agent, opts.pairWith);

const appendProofPrompt = (parts: string[], proof: string): void => {
  const trimmed = proof.trim();
  if (!trimmed) {
    return;
  }
  parts.push(`Proof requirements:\n${trimmed}`);
};

const humanClarificationGuidance = (): string =>
  "Use AskUserQuestion, or the equivalent user-input tool if available, whenever scope, requirements, acceptance criteria, or direction are unclear. Ask concise questions before guessing, and confirm direction when a choice would materially affect the work.";

const reviewerCheckpointGuidance = (peer: string): string =>
  `Ask ${peer} for validation and feedback after every few concrete steps, after any meaningful design choice, and before finalizing. Keep requests specific: summarize what changed, what proof ran, and what decision or risk you want checked.`;

const reviewerSessionStateGuidance = (primary: string): string =>
  `When reviewing, check that ${primary} keeps PLAN.md and status.md current enough for handoff: what changed, proof/checks run, open questions, risks, and next steps.`;

const pairedContextGuidance = (opts: Options, agent: Agent): string[] => {
  const peer = pairedPeer(opts);
  const pair = new Set<Agent>([opts.agent, peer]);
  if (!(pair.has("claude") && pair.has("codex"))) {
    return [];
  }

  if (agent === "claude") {
    return [
      "Context role: use Claude's larger context window as the session memory. Preserve historical decisions, prior failed paths, user preferences, and acceptance criteria.",
      "When asking Codex for work or review, include the small recent slice it needs: current objective, relevant files, latest proof, and the exact question. Answer Codex context questions from session history instead of making it rediscover that history.",
    ];
  }

  if (agent === "codex") {
    return [
      "Context role: optimize for Codex's smaller context window. Stay focused on the immediate request, current diff, latest logs, and next verification step.",
      "Do not reconstruct long session history unless it is directly needed. Ask Claude for missing historical context, decisions, or acceptance criteria, and make frequent targeted calls with concise findings, proof, and specific questions.",
    ];
  }

  return [];
};

const quotedClaudeTmuxBridgeTool = (
  serverName: string,
  tool: BridgeTool
): string => `"mcp__${serverName}__${tool}"`;

const pairedBridgeGuidance = (
  agent: Agent,
  target: Agent,
  serverName: string
): string => {
  const peer = capitalize(target);
  if (agent === "claude") {
    return [
      `Your bridge MCP server is "${serverName}". Use ${quotedClaudeTmuxBridgeTool(serverName, "send_message")} with target: "${target}" for ${peer}-facing messages, including replies to inbound ${peer} channel messages; do not send ${peer}-facing responses as a human-facing message.`,
      singleBridgeTransportGuidance,
      mandatoryUtilityDelegationGuidance(
        quotedClaudeTmuxBridgeTool(serverName, "route_task")
      ),
      `For a returned worker edit, review the patch artifact and use ${quotedClaudeTmuxBridgeTool(serverName, "apply_task_patch")} with its exact SHA-256; never bypass guarded preimage verification.`,
      `Use ${quotedClaudeTmuxBridgeTool(serverName, "bridge_status")} or ${quotedClaudeTmuxBridgeTool(serverName, "receive_messages")} only if delivery looks stuck.`,
    ].join("\n");
  }

  return [
    `Use the MCP tool ${quotedBridgeTool(agent, "send_message")} with target: "${target}" for ${peer}-facing messages, not a human-facing message.`,
    singleBridgeTransportGuidance,
    mandatoryUtilityDelegationGuidance(
      quotedBridgeTool(agent, "route_task")
    ),
    `For a returned worker edit, review the patch artifact and use ${quotedBridgeTool(agent, "apply_task_patch")} with its exact SHA-256; never bypass guarded preimage verification.`,
    `Use ${quotedBridgeTool(agent, "bridge_status")} or ${quotedBridgeTool(agent, "receive_messages")} only if delivery looks stuck.`,
  ].join("\n");
};

const pairedWorkflowGuidance = (opts: Options, agent: Agent): string => {
  const primary = capitalize(opts.agent);
  const peer = capitalize(pairedPeer(opts));

  if (agent === opts.agent) {
    return [
      `You are the main worker. ${peer} reviews and helps on request.`,
      ...pairedContextGuidance(opts, agent),
      "Implement and verify first, then ask for review.",
      reviewerCheckpointGuidance(peer),
      "Keep iterating until your own review and the peer review both pass.",
      "After both pass, handle the PR yourself: create a draft PR or send a follow-up commit to the existing PR.",
      SESSION_STATE_GUIDANCE,
      humanClarificationGuidance(),
    ].join("\n");
  }

  return [
    `${primary} is the main worker. You are the reviewer/support agent.`,
    ...pairedContextGuidance(opts, agent),
    "Do not take over the task or create the PR yourself.",
    `When ${primary} asks, do a real review against the task, proof requirements, and repo state.`,
    `Expect ${primary} to request validation every few concrete steps. Give timely feedback, identify risks early, and ask ${primary} to clarify any ambiguous claim before approving it.`,
    reviewerSessionStateGuidance(primary),
    "Send either clear actionable feedback or an explicit approval.",
    humanClarificationGuidance(),
  ].join("\n");
};

const buildPrimaryPrompt = (
  task: string,
  opts: Options,
  runId: string,
  serverName: string
): string => {
  const peerAgentName = pairedPeer(opts);
  const peer = capitalize(peerAgentName);
  const parts = [
    `Agent-to-agent pair programming: you are the primary ${capitalize(opts.agent)} agent for this run.`,
    `Task:\n${task.trim()}`,
    `Your peer is ${peer}. Do the initial pass yourself, then use ${quotedBridgeTool(opts.agent, "send_message")} when you want review or targeted help from ${peer}.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(SPAWN_TEAM_WITH_WORKTREE_ISOLATION);
  parts.push(pairedBridgeGuidance(opts.agent, peerAgentName, serverName));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `Inspect the repo and start. Ask ${peer} for review once you have concrete work or a specific question.`
  );
  parts.push(humanClarificationGuidance());
  return parts.join("\n\n");
};

const buildPeerPrompt = (
  task: string,
  opts: Options,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Agent-to-agent pair programming: ${primary} is the primary agent for this run.`,
    `Task:\n${task.trim()}`,
    `You are ${capitalize(agent)}. Do not start implementing or verifying this task on your own.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent, opts.agent, serverName));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `Wait for ${primary} to send you a targeted request or review ask.`
  );
  parts.push(humanClarificationGuidance());
  return parts.join("\n\n");
};

const buildInteractivePrimaryPrompt = (
  opts: Options,
  runId: string,
  serverName: string
): string => {
  const peerAgentName = pairedPeer(opts);
  const peer = capitalize(peerAgentName);
  const parts = [
    `Agent-to-agent pair programming: you are the primary ${capitalize(opts.agent)} agent for this run.`,
    "No task has been assigned yet.",
    "This is a human-driven interactive run. It does not require a prewritten PLAN.md, Harness task, or queued slice.",
    `Your peer is ${peer}. Use ${quotedBridgeTool(opts.agent, "send_message")} for review or help once the human gives you a task.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(
    `${SPAWN_TEAM_WITH_WORKTREE_ISOLATION} Apply that once the human gives you a concrete task.`
  );
  parts.push(pairedBridgeGuidance(opts.agent, peerAgentName, serverName));
  parts.push(pairedWorkflowGuidance(opts, opts.agent));
  parts.push(
    `If the human asks for plan mode, write PLAN.md first, ask ${peer} for a plan review, iterate on PLAN.md, then ask the human to review the plan before implementing.`
  );
  parts.push(
    "For any sustained task, create or update PLAN.md and status.md before implementation once the task is clear; keep status.md as the end-of-session handoff for the next loop."
  );
  parts.push(
    "Before starting implementation, use AskUserQuestion or the available user-input tool to clarify the task, scope, constraints, acceptance criteria, and desired proof unless the human has already made them clear."
  );
  parts.push(reviewerCheckpointGuidance(peer));
  parts.push(
    `Wait for the first human task. Do not implement until one arrives. Once it does, coordinate directly with ${peer} and keep the paired review workflow intact. Do not send a message to ${peer} until then.`
  );
  parts.push(humanClarificationGuidance());
  return parts.join("\n\n");
};

const buildInteractivePeerPrompt = (
  opts: Options,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const primary = capitalize(opts.agent);
  const parts = [
    `Agent-to-agent pair programming: ${primary} is the primary agent for this run.`,
    "No task has been assigned yet.",
    "This is a human-driven interactive run. It does not require a prewritten PLAN.md, Harness task, or queued slice.",
    `You are ${capitalize(agent)}. Stay idle until ${primary} sends a specific request or the human clearly assigns you separate work.`,
  ];
  appendProofPrompt(parts, opts.proof);
  parts.push(pairedBridgeGuidance(agent, opts.agent, serverName));
  parts.push(pairedWorkflowGuidance(opts, agent));
  parts.push(
    `If ${primary} asks for a plan review, review PLAN.md only, suggest concrete fixes, and wait for the next request.`
  );
  parts.push(reviewerSessionStateGuidance(primary));
  parts.push(
    `Wait for ${primary} to provide a concrete task or review request. Do not send a message to ${primary} yet. If the human clearly assigns you separate work in this pane, treat that as a new task. If you are answering ${primary}, use the bridge tools instead of a human-facing reply.`
  );
  parts.push(humanClarificationGuidance());
  return parts.join("\n\n");
};

const buildLaunchPrompt = (
  launch: PairedTmuxLaunch,
  agent: Agent,
  runId: string,
  serverName: string
): string => {
  const task = launch.task?.trim();
  if (!task) {
    return launch.opts.agent === agent
      ? buildInteractivePrimaryPrompt(launch.opts, runId, serverName)
      : buildInteractivePeerPrompt(launch.opts, agent, runId, serverName);
  }
  return launch.opts.agent === agent
    ? buildPrimaryPrompt(task, launch.opts, runId, serverName)
    : buildPeerPrompt(task, launch.opts, agent, runId, serverName);
};

const resolveTmuxModel = (agent: Agent, opts: Options): string => {
  const isPrimary = agent === opts.agent;
  if (agent === "codex") {
    return isPrimary
      ? opts.codexModel
      : (opts.codexReviewerModel ?? opts.codexModel);
  }
  if (agent === "claude") {
    return isPrimary
      ? DEFAULT_CLAUDE_MODEL
      : (opts.claudeReviewerModel ?? DEFAULT_CLAUDE_MODEL);
  }
  if (agent === "gemini") {
    return isPrimary
      ? opts.geminiModel
      : (opts.geminiReviewerModel ?? opts.geminiModel);
  }
  if (agent === "copilot") {
    return isPrimary
      ? opts.copilotModel
      : (opts.copilotReviewerModel ?? opts.copilotModel);
  }
  return isPrimary
    ? opts.cursorModel
    : (opts.cursorReviewerModel ?? opts.cursorModel);
};

const buildClaudeCommand = (
  sessionId: string,
  model: string,
  channelServer: string,
  resume: boolean,
  prompt?: string,
  settingsPath?: string
): string[] => {
  const args = [
    "claude",
    resume ? "--resume" : "--session-id",
    sessionId,
    "--model",
    model,
    "--dangerously-load-development-channels",
    `server:${channelServer}`,
    "--dangerously-skip-permissions",
  ];
  if (settingsPath) {
    args.push("--settings", settingsPath);
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

const buildCodexCommand = (
  remoteUrl: string,
  model: string,
  configValues: string[],
  prompt?: string,
  bypassHookTrust?: boolean
): string[] => {
  const defaultConfigArgs = DEFAULT_CODEX_CONFIG_VALUES.flatMap((value) => [
    "-c",
    value,
  ]);
  const args = [
    "codex",
    "-m",
    model,
    ...defaultConfigArgs,
    ...configValues,
    "--enable",
    "tui_app_server",
    "--remote",
    remoteUrl,
  ];
  if (bypassHookTrust) {
    args.push("--dangerously-bypass-hook-trust");
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

const buildGeminiCommand = (
  model: string,
  prompt?: string,
  resumeId?: string
): string[] => {
  const args = ["gemini", "--model", model, "--yolo"];
  if (resumeId) {
    args.push("--resume", resumeId);
  }
  if (prompt) {
    args.push("--prompt-interactive", prompt);
  }
  return args;
};

const buildCursorCommand = (
  model: string,
  prompt?: string,
  resumeId?: string
): string[] => {
  const args = [
    "cursor",
    "agent",
    "--model",
    model,
    "--yolo",
    "--approve-mcps",
  ];
  if (resumeId) {
    args.push("--resume", resumeId);
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

const buildCopilotCommand = (
  model: string,
  prompt?: string,
  resumeId?: string
): string[] => {
  const args = ["copilot", "agent", "--model", model, "--yolo"];
  if (resumeId) {
    args.push("--resume", resumeId);
  }
  if (prompt) {
    args.push(prompt);
  }
  return args;
};

const parseToken = (argv: string[], flag: string): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith(`${flag}=`)) {
      const value = arg.slice(flag.length + 1).trim();
      if (value) {
        return value;
      }
      throw new Error(`Invalid ${flag} value: cannot be empty`);
    }
    if (arg === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      const token = value.trim();
      if (token) {
        return token;
      }
      throw new Error(`Invalid ${flag} value: cannot be empty`);
    }
  }
  return undefined;
};

const resolveRequestedRunId = (
  argv: string[],
  deps: TmuxDeps
): string | undefined => {
  const runId = parseToken(argv, RUN_ID_FLAG);
  const singleAgentMode = isSingleAgentMode(argv);
  if (runId) {
    if (singleAgentMode) {
      return runId;
    }
    const resolved = (() => {
      try {
        return resolveExistingRunId(
          runId,
          deps.cwd,
          deps.env.HOME ?? process.env.HOME ?? ""
        );
      } catch {
        return undefined;
      }
    })();
    if (!resolved) {
      if (cwdMatchesRunId(deps.cwd, runId)) {
        return runId;
      }
      throw new Error(`[loop] paired run "${runId}" does not exist`);
    }
    return resolved;
  }

  const sessionId = parseToken(argv, SESSION_FLAG);
  if (!sessionId) {
    return undefined;
  }

  if (singleAgentMode) {
    return undefined;
  }

  const resolved = (() => {
    try {
      return resolveExistingRunId(
        sessionId,
        deps.cwd,
        deps.env.HOME ?? process.env.HOME ?? ""
      );
    } catch {
      return undefined;
    }
  })();
  if (!resolved) {
    if (cwdMatchesRunId(deps.cwd, sessionId)) {
      return sessionId;
    }
    return undefined;
  }
  return resolved;
};

const cwdMatchesRunId = (cwd: string, runId: string): boolean => {
  const base = sanitizeBase(basename(cwd));
  return base.endsWith(`-loop-${sanitizeBase(runId)}`);
};

const MAX_SESSION_ATTEMPTS = 10_000;
const SESSION_CONFLICT_RE = /duplicate session|already exists/i;
const NO_SESSION_RE = /no sessions|couldn't find session|session .* not found/i;
const LOOP_WORKTREE_SUFFIX_RE = /-loop-[a-z0-9][a-z0-9_-]*$/i;

const stripLoopSuffix = (value: string): string =>
  value.replace(LOOP_WORKTREE_SUFFIX_RE, "") || value;

const resolveRunBase = (
  cwd: string,
  deps: TmuxDeps,
  requestedId?: string
): string => {
  const gitResult = (args: string[]): GitResult | undefined => {
    try {
      return deps.runGit(cwd, args);
    } catch {
      return undefined;
    }
  };

  const commonDir = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (commonDir?.exitCode === 0 && commonDir.stdout) {
    return sanitizeBase(basename(dirname(commonDir.stdout)));
  }

  const topLevel = gitResult([
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ]);
  if (topLevel?.exitCode === 0 && topLevel.stdout) {
    return sanitizeBase(basename(topLevel.stdout));
  }

  const base = sanitizeBase(basename(cwd));
  if (requestedId) {
    const requestedSuffix = `-loop-${sanitizeBase(requestedId)}`;
    if (base.endsWith(requestedSuffix)) {
      return stripLoopSuffix(base.slice(0, -requestedSuffix.length));
    }
  }
  return stripLoopSuffix(base);
};

const buildRunName = (base: string, runId: string | number): string =>
  buildLoopName(base, runId);

const worktreeAvailable = (cwd: string, runName: string): boolean => {
  const repoRoot = (() => {
    try {
      return runGit(cwd, ["rev-parse", "--show-toplevel"], "ignore");
    } catch {
      return undefined;
    }
  })();

  if (!repoRoot) {
    return true;
  }

  if (repoRoot.exitCode !== 0 || !repoRoot.stdout) {
    return true;
  }

  const path = join(dirname(repoRoot.stdout), runName);
  if (existsSync(path)) {
    return false;
  }

  const branch = (() => {
    try {
      return runGit(
        cwd,
        ["show-ref", "--verify", "--quiet", `refs/heads/${runName}`],
        "ignore"
      );
    } catch {
      return undefined;
    }
  })();
  if (!branch) {
    return true;
  }

  if (branch.exitCode === 0) {
    return false;
  }

  return true;
};

const commandExists = (cmd: string): boolean => {
  try {
    spawnSync([cmd, "-V"], { stderr: "ignore", stdout: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const isSessionConflict = (stderr: string): boolean =>
  SESSION_CONFLICT_RE.test(stderr);

const isTerminalDimension = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const buildSessionSizeArgs = (deps: TmuxDeps): string[] => {
  const size = deps.getTerminalSize();
  if (!size) {
    return [];
  }
  if (!(isTerminalDimension(size.columns) && isTerminalDimension(size.rows))) {
    return [];
  }
  return ["-x", String(size.columns), "-y", String(size.rows)];
};

const sessionExists = (
  session: string,
  spawnFn: TmuxDeps["spawn"]
): boolean => {
  const result = spawnFn(["tmux", "has-session", "-t", session]);
  return result.exitCode === 0;
};

const keepSessionAttached = (
  session: string,
  spawnFn: TmuxDeps["spawn"]
): void => {
  spawnFn([
    "tmux",
    "set-window-option",
    "-t",
    `${session}:0`,
    "remain-on-exit",
    "on",
  ]);
};

const isSessionGone = (
  session: string,
  error: unknown,
  spawnFn: TmuxDeps["spawn"]
): boolean =>
  !sessionExists(session, spawnFn) ||
  (error instanceof Error && NO_SESSION_RE.test(error.message));

const buildSessionCommand = (
  deps: TmuxDeps,
  env: string[],
  forwardedArgv: string[]
): string => {
  return buildShellCommand([
    "env",
    ...env,
    ...deps.launchArgv,
    ...forwardedArgv,
  ]);
};

const tmuxStartupMessage = (paired: boolean): string =>
  paired
    ? "[loop] starting paired tmux workspace..."
    : "[loop] starting tmux session...";

interface PairedPaneTargets {
  governess?: string;
  left: string;
  right: string;
  utility?: string;
}

const updatePairedManifest = (
  deps: TmuxDeps,
  storage: RunStorage,
  manifest: RunManifest,
  claudeSessionId: string,
  codexRemoteUrl: string,
  codexThreadId: string,
  session: string,
  paneAgents: { left: Agent; right: Agent },
  primaryAgent: Agent,
  paneTargets: PairedPaneTargets
): void => {
  deps.updateRunManifest(storage.manifestPath, (current) =>
    touchRunManifest(
      {
        ...(current ?? manifest),
        claudeSessionId,
        ...(codexRemoteUrl ? { codexRemoteUrl } : {}),
        codexThreadId,
        cwd: deps.cwd,
        mode: "paired",
        pid: process.pid,
        primaryAgent,
        tmuxSession: session,
        tmuxPaneLeft: paneTargets.left,
        tmuxPaneLeftAgent: paneAgents.left,
        tmuxPaneRight: paneTargets.right,
        tmuxPaneRightAgent: paneAgents.right,
        ...(paneTargets.governess
          ? { governess: true, tmuxPaneGoverness: paneTargets.governess }
          : {}),
        ...(paneTargets.utility
          ? { tmuxPaneUtility: paneTargets.utility }
          : {}),
      },
      new Date().toISOString()
    )
  );
};

interface GovernessHookConfig {
  claudeSettingsPath?: string;
  codexBypassHookTrust: boolean;
}

const writeJsonFile = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

// Inject per-run agent hooks so each agent appends normalized events the
// governess can tail. Claude hooks go through --settings; Codex hooks are
// written only when a per-run CODEX_HOME is in use (never the user's global).
const prepareGovernessHooks = (
  deps: TmuxDeps,
  opts: Options,
  runDir: string,
  paneAgents: { left: Agent; right: Agent }
): GovernessHookConfig => {
  if (!opts.governess) {
    return { codexBypassHookTrust: false };
  }
  const hooksDir = join(runDir, "hooks");
  const pair = [paneAgents.left, paneAgents.right];
  let claudeSettingsPath: string | undefined;
  for (const agent of pair) {
    const command = buildHookCommand(
      deps.launchArgv,
      agent,
      join(hooksDir, `${agent}.jsonl`)
    );
    if (agent === "claude") {
      claudeSettingsPath = join(runDir, "claude-hook-settings.json");
      writeJsonFile(claudeSettingsPath, buildClaudeHookSettings(command));
    }
    if (agent === "codex" && opts.codexHome) {
      writeJsonFile(
        join(opts.codexHome, "hooks.json"),
        buildCodexHooksJson(command)
      );
    }
  }
  return {
    claudeSettingsPath,
    codexBypassHookTrust: pair.includes("codex") && Boolean(opts.codexHome),
  };
};

const passEnv = (env: NodeJS.ProcessEnv, key: string): string[] => {
  const value = env[key];
  return value ? [`${key}=${value}`] : [];
};

const envDisabled = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
};

const unquoteEnvValue = (raw: string): string | undefined => {
  let value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
  } else if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    value = end >= 0 ? value.slice(1, end) : value.slice(1);
    value = value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value || undefined;
};

const envFileValue = (file: string, key: string): string | undefined => {
  if (!existsSync(file)) {
    return undefined;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapedKey}\\s*=\\s*(.*)$`);
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = pattern.exec(line);
      if (match) {
        return unquoteEnvValue(match[1] ?? "");
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const parentDirs = (path: string | undefined, maxDepth = 3): string[] => {
  if (!path) {
    return [];
  }
  const dirs: string[] = [];
  let current = resolve(path);
  for (let i = 0; i < maxDepth; i += 1) {
    dirs.push(current);
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return dirs;
};

const unique = (values: Array<string | undefined>): string[] => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
];

const usageTrackerEnvFiles = (
  env: NodeJS.ProcessEnv,
  cwd: string
): string[] => {
  const explicit = unique([
    env.LOOP_USAGE_TRACKER_ENV_FILE,
    env.USAGE_TRACKER_ENV_FILE,
  ]);
  const roots = unique([
    ...parentDirs(cwd),
    ...parentDirs(process.argv[1] ? dirname(process.argv[1]) : undefined),
    ...parentDirs(process.execPath ? dirname(process.execPath) : undefined),
  ]);
  return unique([
    ...explicit,
    ...roots.flatMap((root) => [
      join(root, ".env"),
      join(root, "usage-tracker", ".env"),
      join(root, "usage-tracker", "clean", ".env"),
      join(root, "usage-tracker-minimal", ".env"),
    ]),
  ]);
};

const usageTrackerEnvFromFiles = (
  env: NodeJS.ProcessEnv,
  cwd: string
): string[] => {
  if (envDisabled(env.LOOP_USAGE_TRACKER_LIMITS)) {
    return [];
  }
  const files = usageTrackerEnvFiles(env, cwd);
  const fallbackUrl =
    env.LOOP_USAGE_TRACKER_URL ||
    env.USAGE_TRACKER_URL ||
    files
      .map((file) => envFileValue(file, "LOOP_USAGE_TRACKER_URL"))
      .find(Boolean) ||
    files.map((file) => envFileValue(file, "USAGE_TRACKER_URL")).find(Boolean);
  const fallbackSecret =
    env.LOOP_USAGE_TRACKER_SECRET ||
    env.USAGE_TRACKER_SECRET ||
    files
      .map((file) => envFileValue(file, "LOOP_USAGE_TRACKER_SECRET"))
      .find(Boolean) ||
    files
      .map((file) => envFileValue(file, "USAGE_TRACKER_SECRET"))
      .find(Boolean);
  return [
    ...(env.LOOP_USAGE_TRACKER_URL || env.USAGE_TRACKER_URL || !fallbackUrl
      ? []
      : [`USAGE_TRACKER_URL=${fallbackUrl}`]),
    ...(env.LOOP_USAGE_TRACKER_SECRET ||
    env.USAGE_TRACKER_SECRET ||
    !fallbackSecret
      ? []
      : [`USAGE_TRACKER_SECRET=${fallbackSecret}`]),
  ];
};

const governessEnv = (
  opts: Options,
  inputEnv: NodeJS.ProcessEnv,
  cwd: string
): string[] => {
  const env = withLegacyGovernessEnv(inputEnv);
  return [
    `LOOP_GOVERNESS_IDLE=${opts.governessIdleSeconds}`,
    `LOOP_GOVERNESS_COOLDOWN=${opts.governessCooldownSeconds}`,
    `LOOP_GOVERNESS_MAX=${opts.governessMaxRecoveries}`,
    `LOOP_GOVERNESS_URL=${opts.governessUrl}`,
    `LOOP_GOVERNESS_MODEL=${opts.governessModel}`,
    ...passEnv(env, "LOOP_GOVERNESS_JUDGES"),
    ...passEnv(env, "LOOP_GOVERNESS_JUDGE_MODE"),
    ...passEnv(env, "LOOP_GOVERNESS_AGENT_RENAME"),
    ...passEnv(env, "LOOP_GOVERNESS_ROLE_BALANCE"),
    ...passEnv(env, "LOOP_GOVERNESS_HANDOFF_MANIFEST"),
    ...passEnv(env, "LOOP_USAGE_TRACKER_LIMITS"),
    ...passEnv(env, "LOOP_USAGE_TRACKER_TIMEOUT_MS"),
    ...passEnv(env, "LOOP_USAGE_TRACKER_URL"),
    ...passEnv(env, "USAGE_TRACKER_URL"),
    ...(env.LOOP_USAGE_TRACKER_SECRET
      ? passEnv(env, "LOOP_USAGE_TRACKER_SECRET")
      : passEnv(env, "USAGE_TRACKER_SECRET")),
    ...usageTrackerEnvFromFiles(env, cwd),
    ...(opts.governessLlmTrace
      ? [`LOOP_GOVERNESS_LLM_TRACE=${opts.governessLlmTrace}`]
      : []),
    ...(opts.governessDryRun ? ["LOOP_GOVERNESS_DRY_RUN=1"] : []),
  ];
};

// Add the full-width bottom governess pane under the agent/utility region.
const startGovernessPane = (
  deps: TmuxDeps,
  opts: Options,
  session: string,
  runId: string,
  paneTarget: string
): string => {
  const command = buildShellCommand([
    "env",
    ...governessEnv(opts, deps.env, deps.cwd),
    ...deps.launchArgv,
    GOVERNESS_SUBCOMMAND,
    runId,
  ]);
  const result = runTmuxCommand(deps, [
    "tmux",
    "split-window",
    "-v",
    "-f",
    "-P",
    "-F",
    "#{pane_id}",
    "-l",
    opts.governessHeight,
    "-t",
    `${session}:0`,
    "-c",
    deps.cwd,
    command,
  ]);
  return stablePaneTarget(result, paneTarget);
};

const utilityPaneEnabled = (env: NodeJS.ProcessEnv): boolean => {
  const value = env.LOOP_UTILITY_PANE?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
};

const utilityPaneWidth = (env: NodeJS.ProcessEnv): string => {
  const value = (
    env.LOOP_UTILITY_PANE_WIDTH ?? env.LOOP_UTILITY_PANE_HEIGHT
  )?.trim();
  return value && UTILITY_PANE_WIDTH_RE.test(value)
    ? value
    : DEFAULT_UTILITY_PANE_WIDTH;
};

export const composeWorkerPaneTitle = (session: string): string =>
  `worker.${session}`;

const startUtilityPane = (
  deps: TmuxDeps,
  session: string,
  governessPane: string,
  utilityPane: string,
  runDir: string
): string => {
  const command = buildShellCommand([
    ...deps.launchArgv,
    UTILITY_PANE_SUBCOMMAND,
    runDir,
  ]);
  const result = runTmuxCommand(deps, [
    "tmux",
    "split-window",
    "-h",
    "-P",
    "-F",
    "#{pane_id}",
    "-l",
    utilityPaneWidth(deps.env),
    "-t",
    governessPane,
    "-c",
    deps.cwd,
    command,
  ]);
  const pane = stablePaneTarget(result, utilityPane);
  const title = composeWorkerPaneTitle(session);
  deps.spawn(["tmux", "set-option", "-p", "-t", pane, "@loop_label", title]);
  deps.spawn(["tmux", "select-pane", "-t", pane, "-T", title]);
  return pane;
};

const registerClaudeChannelServerForRun = (
  deps: TmuxDeps,
  serverName: string,
  runDir: string
): void => {
  registerClaudeChannelServer(deps.launchArgv, serverName, runDir, (args) =>
    deps.spawn(args)
  );
};

const cleanupFailedPairedSessionStart = (
  deps: TmuxDeps,
  session: string,
  serverName: string | undefined,
  runId: string
): void => {
  try {
    if (sessionExists(session, deps.spawn)) {
      deps.spawn(["tmux", "kill-session", "-t", session]);
    }
  } catch {
    // Best-effort cleanup after a failed paired startup.
  }
  for (const name of new Set(
    [serverName, legacyClaudeChannelServerName(runId)].filter(
      (value): value is string => Boolean(value)
    )
  )) {
    removeClaudeChannelServer(name, (args) => deps.spawn(args), deps.log);
  }
};

const preparePersistentTmuxLaunch = async (
  deps: TmuxDeps,
  opts: Options,
  manifest: RunManifest
): Promise<{
  claudeSessionId: string;
  codexRemoteUrl: string;
  codexThreadId: string;
}> => {
  const pair = [opts.agent, pairedPeer(opts)];
  const claudeSessionId = pair.includes("claude")
    ? manifest.claudeSessionId ||
      opts.pairedSessionIds?.claude ||
      deps.makeClaudeSessionId()
    : "";
  let codexThreadId = "";
  let codexRemoteUrl = "";

  if (pair.includes("codex")) {
    const codexKind = opts.agent === "codex" ? "work" : "review";
    await deps.startPersistentAgentSession(
      "codex",
      opts,
      manifest.codexThreadId || opts.pairedSessionIds?.codex || undefined,
      {
        codexLaunch: {
          env: codexHomeEnv(opts.codexHome),
          orphanOnExit: true,
        },
      },
      codexKind
    );
    codexThreadId =
      deps.getLastCodexThreadId() ||
      manifest.codexThreadId ||
      opts.pairedSessionIds?.codex ||
      "";
    if (!codexThreadId) {
      throw new Error("[loop] failed to resolve Codex thread for tmux launch");
    }
    codexRemoteUrl = deps.getCodexAppServerUrl();
    if (!codexRemoteUrl) {
      throw new Error(
        "[loop] failed to resolve Codex app-server for tmux launch"
      );
    }
  }

  opts.pairedSessionIds = {
    ...opts.pairedSessionIds,
    ...(claudeSessionId ? { claude: claudeSessionId } : {}),
    ...(codexThreadId ? { codex: codexThreadId } : {}),
  };
  return { claudeSessionId, codexRemoteUrl, codexThreadId };
};

const resolveTmuxPaneAgents = (
  primary: Agent,
  peer: Agent
): { left: Agent; right: Agent } => {
  if (primary === "codex" || peer === "codex") {
    return {
      left: primary === "codex" ? peer : primary,
      right: "codex",
    };
  }
  if (primary === "claude" || peer === "claude") {
    return {
      left: "claude",
      right: primary === "claude" ? peer : primary,
    };
  }
  return { left: primary, right: peer };
};

const buildPairedAgentCommand = ({
  agent,
  claudeChannelServer,
  claudeSessionId,
  claudeSettingsPath,
  codexBypassHookTrust,
  codexProxyUrl,
  hadSession,
  opts,
  prompt,
}: {
  agent: Agent;
  claudeChannelServer: string | undefined;
  claudeSessionId: string;
  claudeSettingsPath?: string;
  codexBypassHookTrust?: boolean;
  codexProxyUrl: string;
  hadSession: boolean;
  opts: Options;
  prompt?: string;
}): string[] => {
  const model = resolveTmuxModel(agent, opts);
  if (agent === "claude") {
    if (!claudeChannelServer) {
      throw new Error("[loop] missing Claude bridge config for tmux launch");
    }
    return buildClaudeCommand(
      claudeSessionId,
      model,
      claudeChannelServer,
      hadSession,
      prompt,
      claudeSettingsPath
    );
  }
  if (agent === "codex") {
    if (!opts.codexMcpConfigArgs?.length) {
      throw new Error("[loop] missing Codex bridge config for tmux launch");
    }
    if (!codexProxyUrl) {
      throw new Error("[loop] missing Codex proxy for tmux launch");
    }
    return buildCodexCommand(
      codexProxyUrl,
      model,
      opts.codexMcpConfigArgs,
      prompt,
      codexBypassHookTrust
    );
  }
  if (agent === "gemini") {
    return buildGeminiCommand(
      model,
      prompt,
      hadSession ? opts.pairedSessionIds?.gemini : undefined
    );
  }
  if (agent === "copilot") {
    return buildCopilotCommand(
      model,
      prompt,
      hadSession ? opts.pairedSessionIds?.copilot : undefined
    );
  }
  return buildCursorCommand(
    model,
    prompt,
    hadSession ? opts.pairedSessionIds?.cursor : undefined
  );
};

const runTmuxCommand = (
  deps: TmuxDeps,
  args: string[],
  message = "Failed to start tmux session"
): SpawnResult => {
  const result = deps.spawn(args);
  if (result.exitCode === 0) {
    return result;
  }
  const suffix = result.stderr ? `: ${result.stderr}` : ".";
  throw new Error(`${message}${suffix}`);
};

const TMUX_PANE_ID_RE = /^%\d+$/;

const stablePaneId = (result: SpawnResult): string | undefined => {
  const paneId = result.stdout?.trim();
  return paneId && TMUX_PANE_ID_RE.test(paneId) ? paneId : undefined;
};

const stablePaneTarget = (
  result: SpawnResult,
  fallback: string
): string => stablePaneId(result) ?? fallback;

const normalizePaneText = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const detectClaudePrompt = (text: string): "bypass" | "confirm" | undefined => {
  const normalized = normalizePaneText(text);
  if (
    normalized.includes(CLAUDE_BYPASS_PROMPT) ||
    (normalized.includes(CLAUDE_BYPASS_MODE) &&
      normalized.includes(CLAUDE_BYPASS_ACCEPT) &&
      normalized.includes(CLAUDE_EXIT_OPTION))
  ) {
    return "bypass";
  }
  if (normalized.includes(CLAUDE_TRUST_PROMPT)) {
    return "confirm";
  }
  if (
    normalized.includes(CLAUDE_DEV_CHANNELS_PROMPT) &&
    normalized.includes(CLAUDE_DEV_CHANNELS_CONFIRM)
  ) {
    return "confirm";
  }
  return undefined;
};

const unblockClaudePane = async (
  pane: string,
  deps: TmuxDeps
): Promise<void> => {
  let handledPrompt = false;
  let lastSnapshot = "";
  let quietPolls = 0;
  let sawOutput = false;

  for (let attempt = 0; attempt < CLAUDE_PROMPT_MAX_POLLS; attempt += 1) {
    const snapshot = normalizePaneText(deps.capturePane(pane));
    const prompt = detectClaudePrompt(snapshot);
    if (prompt === "confirm") {
      deps.sendKeys(pane, ["Enter"]);
      handledPrompt = true;
      lastSnapshot = "";
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }
    if (prompt === "bypass") {
      deps.sendKeys(pane, ["Down"]);
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      deps.sendKeys(pane, ["Enter"]);
      handledPrompt = true;
      lastSnapshot = "";
      quietPolls = 0;
      await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
      continue;
    }

    if (snapshot) {
      sawOutput = true;
    }
    quietPolls = snapshot === lastSnapshot ? quietPolls + 1 : 0;
    lastSnapshot = snapshot;
    if (handledPrompt && quietPolls >= CLAUDE_PROMPT_SETTLE_POLLS) {
      return;
    }
    if (sawOutput && quietPolls >= CLAUDE_PROMPT_SETTLE_POLLS) {
      return;
    }
    if (attempt + 1 >= CLAUDE_PROMPT_MAX_POLLS) {
      return;
    }
    await deps.sleep(CLAUDE_PROMPT_POLL_DELAY_MS);
  }
};

const createPairedPaneLayout = async (input: {
  deps: TmuxDeps;
  governess: boolean;
  leftCommand: string;
  paneAgents: { left: Agent; right: Agent };
  rightCommand: string;
  runDir: string;
  session: string;
}): Promise<PairedPaneTargets> => {
  const leftResult = runTmuxCommand(input.deps, [
    "tmux",
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    ...buildSessionSizeArgs(input.deps),
    "-s",
    input.session,
    "-c",
    input.deps.cwd,
    input.leftCommand,
  ]);
  const left = stablePaneTarget(leftResult, `${input.session}:0.0`);
  const rightResult = runTmuxCommand(
    input.deps,
    [
      "tmux",
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      left,
      "-c",
      input.deps.cwd,
      input.rightCommand,
    ],
    "Failed to split tmux window"
  );
  const rightPaneId = stablePaneId(rightResult);
  const rightBeforeUtility = rightPaneId ?? `${input.session}:0.1`;
  input.deps.spawn([
    "tmux",
    "select-layout",
    "-t",
    `${input.session}:0`,
    "even-horizontal",
  ]);
  if (input.paneAgents.left === "claude") {
    await unblockClaudePane(left, input.deps);
  }
  if (input.paneAgents.right === "claude") {
    await unblockClaudePane(rightBeforeUtility, input.deps);
  }
  return {
    governess: input.governess ? `${input.session}:0.2` : undefined,
    left,
    right: rightPaneId ?? `${input.session}:0.1`,
  };
};

const startPairedControlPanes = (
  deps: TmuxDeps,
  opts: Options,
  session: string,
  runId: string,
  runDir: string,
  paneTargets: PairedPaneTargets
): PairedPaneTargets => {
  let governess = paneTargets.governess;
  if (paneTargets.governess) {
    governess = startGovernessPane(
      deps,
      opts,
      session,
      runId,
      paneTargets.governess
    );
  }
  const utility =
    governess && utilityPaneEnabled(deps.env)
      ? startUtilityPane(
          deps,
          session,
          governess,
          `${session}:0.3`,
          runDir
        )
      : undefined;
  return { ...paneTargets, governess, utility };
};

const startPairedSession = async (
  deps: TmuxDeps,
  launch: PairedTmuxLaunch
): Promise<string> => {
  const { manifest, storage } = deps.preparePairedRun(launch.opts, deps.cwd);
  const runBase = resolveRunBase(deps.cwd, deps, storage.runId);
  const session = buildRunName(runBase, storage.runId);
  const primaryAgent = launch.opts.agent;
  const secondaryAgent = pairedPeer(launch.opts);
  const paneAgents = resolveTmuxPaneAgents(primaryAgent, secondaryAgent);
  if (sessionExists(session, deps.spawn)) {
    deps.updateRunManifest(storage.manifestPath, (current) =>
      touchRunManifest(
        {
          ...(current ?? manifest),
          cwd: deps.cwd,
          mode: "paired",
          pid: process.pid,
          primaryAgent,
          tmuxSession: session,
          tmuxPaneLeftAgent: paneAgents.left,
          tmuxPaneRightAgent: paneAgents.right,
        },
        new Date().toISOString()
      )
    );
    return session;
  }
  const hadAgentSession: Record<Agent, boolean> = {
    claude: Boolean(
      manifest.claudeSessionId || launch.opts.pairedSessionIds?.claude
    ),
    codex: Boolean(
      manifest.codexThreadId || launch.opts.pairedSessionIds?.codex
    ),
    gemini: Boolean(launch.opts.pairedSessionIds?.gemini),
    cursor: Boolean(launch.opts.pairedSessionIds?.cursor),
    copilot: Boolean(launch.opts.pairedSessionIds?.copilot),
  };
  // Only boot persistent transports when claude or codex is in the pair
  const needsPersistent = [primaryAgent, secondaryAgent].some(
    (a) => a === "claude" || a === "codex"
  );
  let claudeSessionId = "";
  let codexRemoteUrl = "";
  let codexThreadId = "";
  let codexProxyUrl = "";
  if (needsPersistent) {
    const persistent = await preparePersistentTmuxLaunch(
      deps,
      launch.opts,
      manifest
    );
    claudeSessionId = persistent.claudeSessionId;
    codexRemoteUrl = persistent.codexRemoteUrl;
    codexThreadId = persistent.codexThreadId;
    if (codexThreadId && codexRemoteUrl) {
      codexProxyUrl = await deps.startCodexProxy(
        storage.runDir,
        codexRemoteUrl,
        codexThreadId
      );
    }
  }
  const claudeChannelServer = [primaryAgent, secondaryAgent].includes("claude")
    ? resolveClaudeChannelServerName(
        storage.runId,
        storage.repoId,
        manifest.claudeChannelServer
      )
    : undefined;
  if (claudeChannelServer) {
    registerClaudeChannelServerForRun(
      deps,
      claudeChannelServer,
      storage.runDir
    );
  }
  try {
    const env = [
      `${RUN_BASE_ENV}=${runBase}`,
      `${RUN_ID_ENV}=${storage.runId}`,
      ...(launch.opts.codexHome ? [`CODEX_HOME=${launch.opts.codexHome}`] : []),
    ];
    const leftPrompt = hadAgentSession[paneAgents.left]
      ? undefined
      : buildLaunchPrompt(
          launch,
          paneAgents.left,
          storage.runId,
          claudeChannelServer ?? ""
        );
    const rightPrompt = hadAgentSession[paneAgents.right]
      ? undefined
      : buildLaunchPrompt(
          launch,
          paneAgents.right,
          storage.runId,
          claudeChannelServer ?? ""
        );
    const governessHooks = prepareGovernessHooks(
      deps,
      launch.opts,
      storage.runDir,
      paneAgents
    );
    const leftCommand = buildShellCommand([
      "env",
      ...env,
      ...buildPairedAgentCommand({
        agent: paneAgents.left,
        claudeChannelServer,
        claudeSessionId,
        claudeSettingsPath: governessHooks.claudeSettingsPath,
        codexBypassHookTrust: governessHooks.codexBypassHookTrust,
        codexProxyUrl,
        hadSession: hadAgentSession[paneAgents.left],
        opts: launch.opts,
        prompt: leftPrompt,
      }),
    ]);
    const rightCommand = buildShellCommand([
      "env",
      ...env,
      ...buildPairedAgentCommand({
        agent: paneAgents.right,
        claudeChannelServer,
        claudeSessionId,
        claudeSettingsPath: governessHooks.claudeSettingsPath,
        codexBypassHookTrust: governessHooks.codexBypassHookTrust,
        codexProxyUrl,
        hadSession: hadAgentSession[paneAgents.right],
        opts: launch.opts,
        prompt: rightPrompt,
      }),
    ]);

    const paneTargets = await createPairedPaneLayout({
      deps,
      governess: launch.opts.governess,
      leftCommand,
      paneAgents,
      rightCommand,
      runDir: storage.runDir,
      session,
    });
    updatePairedManifest(
      deps,
      storage,
      manifest,
      claudeSessionId,
      codexRemoteUrl,
      codexThreadId,
      session,
      paneAgents,
      primaryAgent,
      paneTargets
    );
    const livePaneTargets = startPairedControlPanes(
      deps,
      launch.opts,
      session,
      storage.runId,
      storage.runDir,
      paneTargets
    );
    if (
      livePaneTargets.governess !== paneTargets.governess ||
      livePaneTargets.utility !== paneTargets.utility
    ) {
      updatePairedManifest(
        deps,
        storage,
        manifest,
        claudeSessionId,
        codexRemoteUrl,
        codexThreadId,
        session,
        paneAgents,
        primaryAgent,
        livePaneTargets
      );
    }
    const primaryPane =
      paneAgents.left === primaryAgent
        ? livePaneTargets.left
        : livePaneTargets.right;
    deps.spawn(["tmux", "select-pane", "-t", primaryPane]);
    return session;
  } catch (error: unknown) {
    cleanupFailedPairedSessionStart(
      deps,
      session,
      claudeChannelServer,
      storage.runId
    );
    throw error;
  }
};

const startRequestedSession = (
  deps: TmuxDeps,
  runBase: string,
  requestedId: string,
  forwardedArgv: string[]
): string => {
  const candidate = buildRunName(runBase, requestedId);
  const existingSession = sessionExists(candidate, deps.spawn);
  if (existingSession) {
    return candidate;
  }

  const command = buildSessionCommand(
    deps,
    [`${RUN_BASE_ENV}=${runBase}`, `${RUN_ID_ENV}=${requestedId}`],
    forwardedArgv
  );
  const result = deps.spawn([
    "tmux",
    "new-session",
    "-d",
    ...buildSessionSizeArgs(deps),
    "-s",
    candidate,
    "-c",
    deps.cwd,
    command,
  ]);
  if (result.exitCode === 0) {
    return candidate;
  }

  const suffix = result.stderr ? `: ${result.stderr}` : ".";
  throw new Error(`Failed to start tmux session${suffix}`);
};

const startAutoSession = (
  deps: TmuxDeps,
  runBase: string,
  forwardedArgv: string[],
  needsWorktree: boolean
): string => {
  for (let index = 1; index <= MAX_SESSION_ATTEMPTS; index += 1) {
    const candidate = buildRunName(runBase, index);
    if (needsWorktree && !worktreeAvailable(deps.cwd, candidate)) {
      continue;
    }

    const command = buildSessionCommand(
      deps,
      [`${RUN_BASE_ENV}=${runBase}`, `${RUN_ID_ENV}=${index}`],
      forwardedArgv
    );
    const result = deps.spawn([
      "tmux",
      "new-session",
      "-d",
      ...buildSessionSizeArgs(deps),
      "-s",
      candidate,
      "-c",
      deps.cwd,
      command,
    ]);
    if (result.exitCode === 0) {
      return candidate;
    }
    if (!isSessionConflict(result.stderr)) {
      const suffix = result.stderr ? `: ${result.stderr}` : ".";
      throw new Error(`Failed to start tmux session${suffix}`);
    }
  }

  return "";
};

const defaultDeps = (): TmuxDeps => ({
  attach: (session: string) => {
    const result = spawnSync(["tmux", "attach", "-t", session], {
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to attach to tmux session "${session}".`);
    }
  },
  capturePane: (pane: string) => {
    const result = spawnSync(["tmux", "capture-pane", "-p", "-t", pane], {
      stderr: "ignore",
      stdout: "pipe",
    });
    return decode(result.stdout);
  },
  cwd: process.cwd(),
  env: process.env,
  findBinary: (cmd: string) => commandExists(cmd),
  getCodexAppServerUrl,
  getLastCodexThreadId,
  getTerminalSize: () => {
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    if (!(isTerminalDimension(columns) && isTerminalDimension(rows))) {
      return undefined;
    }
    return { columns, rows };
  },
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  launchArgv: buildLaunchArgv(),
  log: (line: string) => {
    console.log(line);
  },
  makeClaudeSessionId: () => randomUUID(),
  preparePairedRun,
  runGit: (cwd: string, args: string[]) => runGit(cwd, args),
  sendKeys: (pane: string, keys: string[]) => {
    spawnSync(["tmux", "send-keys", "-t", pane, ...keys], { stderr: "ignore" });
  },
  sendText: (pane: string, text: string) => {
    spawnSync(["tmux", "send-keys", "-t", pane, "-l", "--", text], {
      stderr: "ignore",
    });
  },
  sleep: (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  startCodexProxy: async (
    runDir: string,
    remoteUrl: string,
    threadId: string
  ) => {
    const port = await findCodexTmuxProxyPort();
    spawnDetachedProcess(
      [
        ...buildLaunchArgv(),
        CODEX_TMUX_PROXY_SUBCOMMAND,
        runDir,
        remoteUrl,
        threadId,
        String(port),
      ],
      process.env
    );
    return waitForCodexTmuxProxy(port);
  },
  closePersistentCodexSession,
  releasePersistentCodexSession,
  startPersistentAgentSession,
  spawn: (args: string[]) => {
    const result = spawnSync(args, { stderr: "pipe", stdout: "pipe" });
    return {
      exitCode: result.exitCode,
      stderr: decode(result.stderr),
      stdout: decode(result.stdout),
    };
  },
  updateRunManifest,
});

const findSession = (argv: string[], deps: TmuxDeps): string => {
  const forwardedArgv = stripTmuxFlag(argv);
  const requestedId = resolveRequestedRunId(argv, deps);
  const runBase = resolveRunBase(deps.cwd, deps, requestedId);
  const needsWorktree = argv.includes(WORKTREE_FLAG);

  if (requestedId !== undefined) {
    return startRequestedSession(deps, runBase, requestedId, forwardedArgv);
  }

  return startAutoSession(deps, runBase, forwardedArgv, needsWorktree);
};

const attachSessionIfInteractive = (
  session: string,
  deps: TmuxDeps
): boolean => {
  if (!deps.isInteractive()) {
    return true;
  }

  try {
    deps.attach(session);
    return true;
  } catch (error: unknown) {
    if (isSessionGone(session, error, deps.spawn)) {
      deps.log(
        `[loop] tmux session "${session}" exited before attach, continuing here.`
      );
      return false;
    }
    throw error instanceof Error
      ? error
      : new Error(`Failed to attach to tmux session "${session}".`);
  }
};

export const runInTmux = async (
  argv: string[],
  overrides: Partial<TmuxDeps> = {},
  launch?: PairedTmuxLaunch
): Promise<boolean> => {
  if (!argv.includes(TMUX_FLAG)) {
    return false;
  }

  const deps = { ...defaultDeps(), ...overrides };
  const insideTmux = Boolean(deps.env.TMUX);

  if (!deps.findBinary("tmux")) {
    throw new Error(TMUX_MISSING_ERROR);
  }

  const pairedLaunch =
    Boolean(launch) &&
    !isSingleAgentMode(argv) &&
    Boolean(launch?.opts.pairedMode);
  deps.log(tmuxStartupMessage(pairedLaunch));

  const session =
    pairedLaunch && launch
      ? await startPairedSession(deps, launch)
      : findSession(argv, deps);

  if (!session) {
    throw new Error(
      "Failed to start tmux session: no free session name found."
    );
  }

  if (!sessionExists(session, deps.spawn)) {
    throw new Error(`tmux session "${session}" exited before attach.`);
  }

  keepSessionAttached(session, deps.spawn);

  deps.log(`[loop] started tmux session "${session}"`);
  deps.log(`[loop] attach with: tmux attach -t ${session}`);
  const handedOff = insideTmux
    ? true
    : attachSessionIfInteractive(session, deps);
  if (pairedLaunch && handedOff) {
    if (sessionExists(session, deps.spawn)) {
      deps.releasePersistentCodexSession();
    } else {
      await deps.closePersistentCodexSession();
    }
  }
  return handedOff;
};

export const tmuxInternals = {
  buildClaudeCommand,
  buildClaudeChannelServerConfig,
  buildClaudeChannelServerName: claudeChannelServerName,
  buildCodexCommand,
  buildCopilotCommand,
  buildCursorCommand,
  buildGeminiCommand,
  buildInteractivePeerPrompt,
  buildInteractivePrimaryPrompt,
  buildLaunchArgv,
  buildLaunchPrompt,
  buildPeerPrompt,
  buildPrimaryPrompt,
  buildRunName,
  buildShellCommand,
  spawnDetachedProcess,
  isSessionConflict,
  quoteShellArg,
  sanitizeBase,
  stripTmuxFlag,
  utilityPaneEnabled,
  utilityPaneWidth,
  worktreeAvailable,
};
