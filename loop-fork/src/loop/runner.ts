import { spawn } from "bun";
import { isPersistentAgent } from "./agents";
import {
  type ClaudeSdkLaunchOptions,
  hasClaudeSdkProcess,
  interruptClaudeSdk,
  runClaudeTurn,
  startClaudeSdk,
} from "./claude-sdk-server";
import {
  type AppServerLaunchOptions,
  CODEX_TRANSPORT_ENV,
  CODEX_TRANSPORT_EXEC,
  CodexAppServerFallbackError,
  CodexAppServerUnexpectedExitError,
  closeAppServer,
  hasAppServerProcess,
  interruptAppServer,
  releaseAppServer,
  runCodexTurn,
  startAppServer,
  useAppServer,
} from "./codex-app-server";
import { codexHomeEnv } from "./codex-home";
import { createCodexRenderer } from "./codex-render";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_CONFIG_VALUES } from "./constants";
import {
  buildOssRunArgs,
  OSS_COMMAND,
  ossConfigEnv,
  parseOssSessionId,
  resolveOssCredentialEnv,
  setLastOssSessionId,
} from "./oss-adapter";
import { DETACH_CHILD_PROCESS, killChildProcess } from "./process";
import type { Agent, Options, RunResult } from "./types";

type ExitSignal = "SIGINT" | "SIGTERM";
type AgentRunKind = "review" | "work";
interface SpawnConfig {
  args: string[];
  cmd: string;
}

const codexConfigValues = (values: string[] = []): string[] => {
  const overridesEffort = values.some((value) =>
    value.startsWith("model_reasoning_effort=")
  );
  return [
    ...DEFAULT_CODEX_CONFIG_VALUES.filter(
      (value) =>
        !(overridesEffort && value.startsWith("model_reasoning_effort="))
    ),
    ...values,
  ];
};

const codexConfigArgs = (values: string[] = []): string[] =>
  codexConfigValues(values).flatMap((value) => ["-c", value]);
export interface PersistentAgentSessionOptions {
  claudeLaunch?: ClaudeSdkLaunchOptions;
  codexLaunch?: AppServerLaunchOptions;
}

type LegacyAgentRunner = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind?: AgentRunKind
) => Promise<RunResult>;
interface RunnerState {
  runLegacyAgent: LegacyAgentRunner;
  useAppServer: () => boolean;
}

const SIGNAL_EXIT_CODES: Record<ExitSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};
const APP_SERVER_RETRY_LIMIT = 1;
const APP_SERVER_RETRY_LOG =
  "[loop] codex app-server exited unexpectedly. Restarting app-server and retrying.";

const activeChildren = new Set<ReturnType<typeof spawn>>();
let activeAppServerRuns = 0;
let activeClaudeSdkRuns = 0;
let watchingSignals = false;
let fallbackWarned = false;
const runnerState: RunnerState = {
  runLegacyAgent: (agent, prompt, opts, sessionId, kind) =>
    runLegacyAgent(agent, prompt, opts, sessionId, kind),
  useAppServer: () => useAppServer(),
};

const killChildren = (signal: ExitSignal): void => {
  for (const child of activeChildren) {
    killChildProcess(child, signal);
  }
};

const killChildrenHard = (): void => {
  for (const child of activeChildren) {
    killChildProcess(child, "SIGKILL");
  }
};

process.on("exit", killChildrenHard);

const onSigint = (): void => {
  killChildren("SIGINT");
  interruptAppServer("SIGINT");
  interruptClaudeSdk("SIGINT");
  process.exit(SIGNAL_EXIT_CODES.SIGINT);
};

const onSigterm = (): void => {
  killChildren("SIGTERM");
  interruptAppServer("SIGTERM");
  interruptClaudeSdk("SIGTERM");
  process.exit(SIGNAL_EXIT_CODES.SIGTERM);
};

const syncSignalHandlers = (): void => {
  const hasAppServerWork = hasAppServerProcess();
  const hasClaudeSdkWork = hasClaudeSdkProcess();
  const hasWork =
    activeChildren.size > 0 ||
    activeAppServerRuns > 0 ||
    activeClaudeSdkRuns > 0 ||
    hasAppServerWork ||
    hasClaudeSdkWork;
  if (hasWork && !watchingSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    watchingSignals = true;
    return;
  }

  if (!hasWork && watchingSignals) {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    watchingSignals = false;
  }
};

export const buildCommand = (
  agent: Agent,
  prompt: string,
  model: string,
  sessionId?: string,
  opts?: Options
): SpawnConfig => {
  if (agent === "claude") {
    const args = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model,
    ];
    if (opts?.claudeMcpConfigPath) {
      args.push(
        "--mcp-config",
        opts.claudeMcpConfigPath,
        "--strict-mcp-config"
      );
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    return { args, cmd: "claude" };
  }

  if (agent === "codex") {
    const args = [
      "exec",
      "--json",
      "--model",
      model,
      ...codexConfigArgs(opts?.codexMcpConfigArgs),
      "--yolo",
      prompt,
    ];
    return { args, cmd: "codex" };
  }

  // oss — OpenCode-backed provider-neutral seat. The model identifier is
  // passed through unchanged; OpenCode owns provider resolution.
  return {
    args: buildOssRunArgs({
      model,
      prompt,
      sessionId,
      title: opts?.ossSessionTitle,
    }),
    cmd: OSS_COMMAND,
  };
};

const resolveModel = (
  agent: Agent,
  opts: Options,
  kind: AgentRunKind
): string => {
  if (agent === "codex") {
    return kind === "review"
      ? (opts.codexReviewerModel ?? opts.codexModel)
      : opts.codexModel;
  }
  if (agent === "oss") {
    return kind === "review"
      ? (opts.ossReviewerModel ?? opts.ossModel)
      : opts.ossModel;
  }
  if (agent === "claude") {
    return kind === "review"
      ? (opts.claudeReviewerModel ?? DEFAULT_CLAUDE_MODEL)
      : DEFAULT_CLAUDE_MODEL;
  }

  const exhaustive: never = agent;
  throw new Error(`Unknown agent: ${exhaustive}`);
};

const withCodexModel = (opts: Options, model: string): Options => {
  if (opts.codexModel === model) {
    return opts;
  }
  return { ...opts, codexModel: model };
};

const eventMessage = (line: string): string => {
  if (!line.trim().startsWith("{")) {
    return "";
  }

  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const messageValue = nestedMessage(event.message);
    const messageText =
      typeof messageValue?.text === "string" ? messageValue.text.trim() : "";
    const joinTextParts = (
      value: unknown,
      onlyTypedText = false
    ): string | undefined => {
      if (!Array.isArray(value)) {
        return undefined;
      }
      const text = value
        .flatMap((part) => {
          if (typeof part === "string") {
            return part;
          }
          if (!(typeof part === "object" && part !== null)) {
            return [];
          }
          const typedPart = part as {
            content?: string;
            text?: string;
            type?: string;
          };
          if (onlyTypedText && typedPart.type && typedPart.type !== "text") {
            return [];
          }
          return typedPart.text ?? typedPart.content ?? "";
        })
        .join("")
        .trim();
      return text || undefined;
    };
    function nestedMessage(
      value: unknown
    ): { content?: unknown; text?: unknown } | undefined {
      return typeof value === "object" && value !== null
        ? (value as { content?: unknown; text?: unknown })
        : undefined;
    }

    if (
      event.type === "item.completed" &&
      typeof event.item === "object" &&
      event.item !== null &&
      (event.item as { type?: unknown }).type === "agent_message"
    ) {
      return (
        (typeof (event.item as { text?: unknown }).text === "string"
          ? ((event.item as { text: string }).text ?? "").trim()
          : "") ||
        joinTextParts((event.item as { content?: unknown }).content) ||
        ""
      );
    }

    if (event.type === "assistant") {
      return joinTextParts(messageValue?.content, true) || messageText || "";
    }

    if (event.type === "result" && typeof event.result === "string") {
      return event.result.trim();
    }

    if (typeof event.text === "string") {
      return event.text.trim();
    }

    if (typeof event.delta === "string") {
      return event.delta.trim();
    }

    if (typeof event.message === "string") {
      return event.message.trim();
    }

    return joinTextParts(messageValue?.content) || messageText || "";
  } catch {
    return "";
  }
};

const consume = async (
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<void> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        onText(decoder.decode(value, { stream: true }));
      }
    }

    const tail = decoder.decode();
    if (tail) {
      onText(tail);
    }
  } finally {
    reader.releaseLock();
  }
};

const appendParsedLine = (
  text: string,
  opts: Options,
  state: { parsed: string; prettyCount: number; lastMessage: string }
): { parsed: string; prettyCount: number; lastMessage: string } => {
  const trimmed = text.trim();
  if (!trimmed || (opts.format === "pretty" && trimmed === state.lastMessage)) {
    return state;
  }
  if (opts.format === "pretty") {
    if (state.prettyCount > 0) {
      process.stdout.write("\n");
    }
    process.stdout.write(`${trimmed}\n`);
    return {
      lastMessage: trimmed,
      prettyCount: state.prettyCount + 1,
      parsed: `${state.parsed ? `${state.parsed}\n` : ""}${trimmed}`,
    };
  }

  return {
    ...state,
    lastMessage: trimmed,
    parsed: `${state.parsed ? `${state.parsed}\n` : ""}${trimmed}`,
  };
};

const isRetryableAppServerError = (error: unknown): boolean =>
  error instanceof CodexAppServerUnexpectedExitError;

const runCodexAppServerAttempt = async (
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> => {
  const renderer = createCodexRenderer({
    format: opts.format,
    write: (text) => {
      process.stdout.write(text);
    },
  });

  try {
    await startAppServer({
      configValues: codexConfigValues(opts.codexMcpConfigArgs),
      env: codexHomeEnv(opts.codexHome),
      persistentThread: opts.pairedMode === true || Boolean(sessionId),
    });
  } catch (error) {
    if (process.env[CODEX_TRANSPORT_ENV] === CODEX_TRANSPORT_EXEC) {
      throw error;
    }
    throw new CodexAppServerFallbackError(
      error instanceof Error ? error.message : String(error)
    );
  }

  const result = await runCodexTurn(
    prompt,
    opts,
    { onRaw: renderer.onRawLine },
    sessionId
  );
  const finalParsed = result.parsed || renderer.getParsed();
  if (
    opts.format === "pretty" &&
    renderer.wrotePretty() &&
    !finalParsed.endsWith("\n")
  ) {
    process.stdout.write("\n");
  }
  return { ...result, parsed: finalParsed };
};

const runCodexAgent = async (
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  // Legacy codex exec resolves from opts again, so bake the final model into
  // codexModel before either transport path runs.
  const runOpts = withCodexModel(opts, resolveModel("codex", opts, kind));
  if (!runnerState.useAppServer()) {
    return runnerState.runLegacyAgent(
      "codex",
      prompt,
      runOpts,
      sessionId,
      kind
    );
  }

  activeAppServerRuns += 1;
  syncSignalHandlers();
  try {
    let attempts = 0;
    while (true) {
      try {
        return await runCodexAppServerAttempt(prompt, runOpts, sessionId);
      } catch (error) {
        if (
          attempts >= APP_SERVER_RETRY_LIMIT ||
          !isRetryableAppServerError(error)
        ) {
          throw error;
        }
        attempts += 1;
        console.error(APP_SERVER_RETRY_LOG);
      }
    }
  } catch (error) {
    if (
      process.env[CODEX_TRANSPORT_ENV] !== CODEX_TRANSPORT_EXEC &&
      error instanceof CodexAppServerFallbackError
    ) {
      if (!fallbackWarned) {
        fallbackWarned = true;
        console.error(
          "[loop] codex app-server transport failed. Falling back to `codex exec --json`."
        );
      }
      return runnerState.runLegacyAgent(
        "codex",
        prompt,
        runOpts,
        sessionId,
        kind
      );
    }
    throw error;
  } finally {
    activeAppServerRuns -= 1;
    syncSignalHandlers();
  }
};

// The OSS seat gets its run-scoped config directory and, when a mode-0600 key
// file is configured, its provider key through the child environment only.
// Neither ever reaches argv, the manifest, or a trace.
export const legacyAgentEnv = (
  agent: Agent,
  opts: Options,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  if (agent === "codex") {
    return codexHomeEnv(opts.codexHome) ?? env;
  }
  if (agent === "oss") {
    return {
      ...env,
      ...ossConfigEnv(opts.ossConfigDir),
      ...resolveOssCredentialEnv(env).env,
    };
  }
  return env;
};

const runLegacyAgent = async (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  const { args, cmd } = buildCommand(
    agent,
    prompt,
    resolveModel(agent, opts, kind),
    sessionId,
    opts
  );
  const proc = spawn([cmd, ...args], {
    detached: DETACH_CHILD_PROCESS,
    env: legacyAgentEnv(agent, opts),
    stderr: "pipe",
    stdout: "pipe",
  });
  activeChildren.add(proc);
  syncSignalHandlers();

  let stdout = "";
  let stderr = "";
  let parsed = "";
  let pending = "";
  let state = { parsed: "", prettyCount: 0, lastMessage: "" };

  const onLine = (line: string): void => {
    if (agent === "oss") {
      const ossSession = parseOssSessionId(line);
      if (ossSession) {
        setLastOssSessionId(ossSession);
      }
    }
    const message = eventMessage(line);
    if (message) {
      state = appendParsedLine(message, opts, state);
      parsed = state.parsed;
      return;
    }

    if (
      !line.trim().startsWith("{") &&
      opts.format === "pretty" &&
      line.trim()
    ) {
      if (state.prettyCount > 0) {
        process.stdout.write("\n");
      }
      process.stdout.write(`${line}\n`);
      state.prettyCount += 1;
    }
  };

  try {
    const outTask = consume(proc.stdout, (text) => {
      stdout += text;
      pending += text;

      let index = pending.indexOf("\n");
      while (index !== -1) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
      }

      if (opts.format === "raw") {
        process.stdout.write(text);
      }
    });

    const errTask = consume(proc.stderr, (text) => {
      stderr += text;
      process.stderr.write(text);
    });

    await Promise.all([outTask, errTask]);
    if (pending.trim()) {
      onLine(pending);
    }

    const exitCode = await proc.exited;
    return { combined: `${stdout}\n${stderr}`, exitCode, parsed };
  } finally {
    activeChildren.delete(proc);
    syncSignalHandlers();
  }
};

const defaultRunLegacyAgent: LegacyAgentRunner = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind?: AgentRunKind
): Promise<RunResult> => runLegacyAgent(agent, prompt, opts, sessionId, kind);

const runSpawnAgent = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> =>
  runnerState.runLegacyAgent(agent, prompt, opts, sessionId, kind);

export const runnerInternals = {
  reset(): void {
    fallbackWarned = false;
    runnerState.useAppServer = () => useAppServer();
    runnerState.runLegacyAgent = defaultRunLegacyAgent;
  },
  setUseAppServer(next: () => boolean): void {
    runnerState.useAppServer = next;
  },
  setLegacyAgent(next: LegacyAgentRunner): void {
    runnerState.runLegacyAgent = next;
  },
};

const runClaudeAgent = async (
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  const model = resolveModel("claude", opts, kind);
  let parsed = "";
  let state = { parsed: "", prettyCount: 0, lastMessage: "" };
  const onParsed = (text: string): void => {
    state = appendParsedLine(text, opts, state);
    parsed = state.parsed;
  };
  const onRaw = (text: string): void => {
    if (opts.format === "raw") {
      process.stdout.write(`${text}\n`);
    }
  };
  const onDelta = (text: string): void => {
    if (opts.format === "pretty") {
      process.stdout.write(text);
    }
  };

  activeClaudeSdkRuns += 1;
  syncSignalHandlers();
  try {
    if (opts.claudeMcpConfigPath || opts.claudePersistentSession) {
      await startClaudeSdk(model, sessionId, {
        mcpConfig: opts.claudeMcpConfigPath,
        persistent: opts.claudePersistentSession,
      });
    } else {
      await startClaudeSdk(model, sessionId);
    }
    const result = await runClaudeTurn(prompt, opts, {
      onDelta,
      onParsed,
      onRaw,
    });
    return { ...result, parsed: result.parsed || parsed };
  } finally {
    activeClaudeSdkRuns -= 1;
    syncSignalHandlers();
  }
};

const runOssAgent = async (
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => runSpawnAgent("oss", prompt, opts, sessionId, kind);

const runAgentWithKind = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string,
  kind: AgentRunKind = "work"
): Promise<RunResult> => {
  if (agent === "codex") {
    return runCodexAgent(prompt, opts, sessionId, kind);
  }
  if (agent === "claude") {
    return runClaudeAgent(prompt, opts, sessionId, kind);
  }
  return runOssAgent(prompt, opts, sessionId, kind);
};

export const runAgent = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> => runAgentWithKind(agent, prompt, opts, sessionId);

export const runReviewerAgent = (
  agent: Agent,
  prompt: string,
  opts: Options,
  sessionId?: string
): Promise<RunResult> =>
  runAgentWithKind(agent, prompt, opts, sessionId, "review");

export const startPersistentAgentSession = async (
  agent: Agent,
  opts: Options,
  sessionId?: string,
  sessionOptions: PersistentAgentSessionOptions = {},
  kind: AgentRunKind = "work"
): Promise<void> => {
  if (!isPersistentAgent(agent)) {
    return;
  }
  if (agent === "codex") {
    const codexLaunch = sessionOptions.codexLaunch;
    await startAppServer({
      env: codexLaunch?.env ?? codexHomeEnv(opts.codexHome),
      ...(codexLaunch ?? {}),
      configValues: codexConfigValues(
        codexLaunch?.configValues ?? opts.codexMcpConfigArgs
      ),
      persistentThread: true,
      resumeThreadId: sessionId,
      threadModel: resolveModel(agent, opts, kind),
    });
    return;
  }

  await startClaudeSdk(resolveModel(agent, opts, kind), sessionId, {
    mcpConfig:
      sessionOptions.claudeLaunch?.mcpConfig ?? opts.claudeMcpConfigPath,
    ...(sessionOptions.claudeLaunch ?? {}),
    persistent: true,
  });
};

export const releasePersistentCodexSession = (): void => {
  releaseAppServer();
};

export const closePersistentCodexSession = async (): Promise<void> => {
  await closeAppServer();
};
