import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import {
  A2A_LEASE_RECORD_FILE,
  type A2AClientDeps,
  a2aChannelSessionDir,
  a2aMessageStatus,
  acknowledgeA2AWorkflows,
  claimChannelA2AEndpoint,
  claimRunA2AEndpoint,
  readA2ALeaseRecord,
  releaseRecordedA2ALease,
  resolveA2AClientEndpoint,
  sendA2AMessage,
} from "./a2a-session-client";
import { type RunStorage, resolveRunStorage } from "./run-state";
import {
  requireSupervisorEndpointLeaseTtlMs,
  requireSupervisorEndpointRecipient,
  requireSupervisorEndpointRunId,
  requireSupervisorEndpointSessionId,
  SUPERVISOR_ENDPOINT_MANIFEST_FILE,
  supervisorEndpointRoots,
} from "./supervisor-endpoint-lease";
import { supervisorIdFromSlug } from "./supervisor-id";

/**
 * `loop a2a`: a supervisor session's own A2A V2 client.
 *
 *   loop a2a enroll  --as supervisor:x --kind loop-run --run <run-id> [--seat claude|codex]
 *   loop a2a enroll  --as supervisor:x --kind codex-thread --run <run-id>
 *   loop a2a enroll  --as supervisor:x --kind claude-channel --session <id> [--provider-session <id>]
 *                    (each: [--takeover] [--ttl-ms <ms>])
 *   loop a2a release --as supervisor:x (--run <run-id> | --session <id>)
 *   loop a2a send    --as supervisor:x --to supervisor:y --body-file <path> [--message-id <id>] [--context <id>]
 *   loop a2a status  --as supervisor:x --message-id <workflow-id>  (the workflowId send prints)
 *   loop a2a ack     --as supervisor:x --workflow <workflow-id> [--workflow <id>...]
 *
 * The server and token come from the orchestration config and the
 * supervisor's tokenEnv, never from argv. `--as` is required and only that
 * supervisor's tokenEnv is read; an environment that also holds another
 * configured supervisor's token is refused unless `--allow-multi-token-env`
 * is given (run each session with only its own token). `send` reports
 * acceptance, `ack` the recipient's read acknowledgement, `status` all three
 * facts apart; nothing here marks work complete.
 */
export const A2A_COMMAND = "a2a";
const ACTIONS = ["ack", "enroll", "release", "send", "status"] as const;
type A2AAction = (typeof ACTIONS)[number];
export const ALLOW_MULTI_TOKEN_ENV_FLAG = "--allow-multi-token-env";

const USAGE = [
  "Usage: loop a2a <enroll|release|send|status|ack> --as <supervisor:id> [--allow-multi-token-env] ...",
  "  enroll  --kind loop-run --run <run-id> [--seat claude|codex] | --kind codex-thread --run <run-id> | --kind claude-channel --session <id> [--provider-session <id>]; [--takeover] [--ttl-ms <ms>]",
  "  release --run <run-id> | --session <id>",
  "  send    --to <supervisor:id> --body-file <path> [--message-id <id>] [--context <id>]",
  "  status  --message-id <workflow-id> (the workflowId that send prints)",
  "  ack     --workflow <workflow-id> (repeatable)",
].join("\n");

const VALUE_FLAGS: Record<A2AAction, readonly string[]> = {
  ack: ["--as", "--workflow"],
  enroll: [
    "--as",
    "--kind",
    "--provider-session",
    "--run",
    "--seat",
    "--session",
    "--ttl-ms",
  ],
  release: ["--as", "--run", "--session"],
  send: ["--as", "--body-file", "--context", "--message-id", "--to"],
  status: ["--as", "--message-id"],
};
const BOOLEAN_FLAGS: Record<A2AAction, readonly string[]> = {
  ack: [ALLOW_MULTI_TOKEN_ENV_FLAG],
  enroll: [ALLOW_MULTI_TOKEN_ENV_FLAG, "--takeover"],
  release: [ALLOW_MULTI_TOKEN_ENV_FLAG],
  send: [ALLOW_MULTI_TOKEN_ENV_FLAG],
  status: [ALLOW_MULTI_TOKEN_ENV_FLAG],
};
const REPEATABLE = new Set(["--workflow"]);

interface ParsedFlags {
  booleans: Set<string>;
  values: Map<string, string[]>;
}

const usageError = (detail?: string): Error =>
  new Error(detail ? `${detail}\n${USAGE}` : USAGE);

/** Every flag known for the action, each value present, singles at most once. */
const parseFlags = (
  action: A2AAction,
  args: readonly string[]
): ParsedFlags => {
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index] ?? "";
    if (BOOLEAN_FLAGS[action].includes(name)) {
      booleans.add(name);
      continue;
    }
    const value = args[index + 1];
    if (
      !VALUE_FLAGS[action].includes(name) ||
      value === undefined ||
      value.startsWith("--") ||
      !value.trim()
    ) {
      throw usageError(`invalid argument: ${name}`);
    }
    const existing = values.get(name) ?? [];
    if (existing.length > 0 && !REPEATABLE.has(name)) {
      throw usageError(`${name} given more than once`);
    }
    values.set(name, [...existing, value]);
    index++;
  }
  return { booleans, values };
};

const one = (flags: ParsedFlags, name: string): string | undefined =>
  flags.values.get(name)?.[0];

const required = (flags: ParsedFlags, name: string): string => {
  const value = one(flags, name);
  if (!value) {
    throw usageError(`${name} is required`);
  }
  return value;
};

export interface A2ACommandDeps extends A2AClientDeps {
  newMessageId?: () => string;
  now?: () => string;
  readBody?: (path: string) => string;
  resolveRunStorage?: (runId: string) => RunStorage;
}

const runStorageFor = (runId: string, deps: A2ACommandDeps): RunStorage => {
  const storage = (deps.resolveRunStorage ?? resolveRunStorage)(
    requireSupervisorEndpointRunId(runId)
  );
  if (!existsSync(storage.manifestPath)) {
    throw new Error(`run ${runId} has no manifest at ${storage.manifestPath}`);
  }
  return storage;
};

const optionalTtl = (flags: ParsedFlags): number | undefined => {
  const raw = one(flags, "--ttl-ms");
  return raw === undefined
    ? undefined
    : requireSupervisorEndpointLeaseTtlMs(Number(raw));
};

const enroll = async (
  supervisorId: string,
  flags: ParsedFlags,
  deps: A2ACommandDeps
): Promise<Record<string, unknown>> => {
  const kind = required(flags, "--kind");
  const options = {
    ...deps,
    takeover: flags.booleans.has("--takeover"),
    ttlMs: optionalTtl(flags),
  };
  if (kind === "loop-run" || kind === "codex-thread") {
    if (one(flags, "--session") || one(flags, "--provider-session")) {
      throw usageError(`--kind ${kind} takes --run, not --session`);
    }
    const seat = one(flags, "--seat");
    if (
      seat !== undefined &&
      (kind !== "loop-run" || !["claude", "codex"].includes(seat))
    ) {
      throw usageError("--seat is claude or codex, for --kind loop-run only");
    }
    const storage = runStorageFor(required(flags, "--run"), deps);
    const claimed = await claimRunA2AEndpoint(
      {
        kind,
        manifestPath: storage.manifestPath,
        runDir: storage.runDir,
        ...(seat ? { seat: seat as "claude" | "codex" } : {}),
        supervisorId,
      },
      options
    );
    return {
      action: "enroll",
      leaseRecord: claimed.dir,
      receipt: claimed.receipt,
    };
  }
  if (kind === "claude-channel") {
    if (one(flags, "--run") || one(flags, "--seat")) {
      throw usageError("--kind claude-channel takes --session, not --run");
    }
    const providerSessionId = one(flags, "--provider-session");
    const claimed = await claimChannelA2AEndpoint(
      {
        ...(providerSessionId
          ? {
              providerSessionId:
                requireSupervisorEndpointSessionId(providerSessionId),
            }
          : {}),
        sessionId: required(flags, "--session"),
        supervisorId,
      },
      options
    );
    return {
      action: "enroll",
      // How the Claude Code session serves the channel this lease names.
      channelServer: {
        args: ["__bridge-mcp", claimed.dir, "claude"],
        note: "start Claude Code with this MCP server and --dangerously-load-development-channels server:<its name>",
      },
      leaseRecord: claimed.dir,
      receipt: claimed.receipt,
    };
  }
  throw usageError("--kind is loop-run, codex-thread or claude-channel");
};

const release = async (
  supervisorId: string,
  flags: ParsedFlags,
  deps: A2ACommandDeps
): Promise<Record<string, unknown>> => {
  const runId = one(flags, "--run");
  const sessionId = one(flags, "--session");
  if (Boolean(runId) === Boolean(sessionId)) {
    throw usageError("release takes exactly one of --run or --session");
  }
  const dir = runId
    ? runStorageFor(runId, deps).runDir
    : a2aChannelSessionDir(
        supervisorId,
        requireSupervisorEndpointSessionId(sessionId),
        deps.env
      );
  // Checked before anything is sent: the release would otherwise act with the
  // recorded supervisor's token on behalf of another --as.
  const recorded = readA2ALeaseRecord(dir);
  if (recorded && recorded.supervisorId !== supervisorId) {
    throw new Error(`the lease in ${dir} belongs to ${recorded.supervisorId}`);
  }
  const outcome = await releaseRecordedA2ALease(dir, deps);
  if (outcome.outcome === "failed") {
    throw new Error(`release failed: ${outcome.detail}`);
  }
  if (outcome.outcome === "none") {
    throw new Error(`no A2A lease is recorded in ${dir}`);
  }
  return { action: "release", ...outcome };
};

export const runA2ACommand = async (
  argv: readonly string[],
  callerDeps: A2ACommandDeps = {}
): Promise<Record<string, unknown>> => {
  const [, requested, ...rest] = argv;
  const action = requested as A2AAction;
  if (!ACTIONS.includes(action)) {
    throw usageError();
  }
  const flags = parseFlags(action, rest);
  const supervisorId = requireSupervisorEndpointRecipient(
    required(flags, "--as")
  );
  // Only the human flag opts in to a multi-token environment.
  const deps: A2ACommandDeps = {
    ...callerDeps,
    allowMultiTokenEnv: flags.booleans.has(ALLOW_MULTI_TOKEN_ENV_FLAG),
  };
  if (action === "enroll") {
    return await enroll(supervisorId, flags, deps);
  }
  if (action === "release") {
    return await release(supervisorId, flags, deps);
  }
  const endpoint = resolveA2AClientEndpoint(supervisorId, deps);
  if (action === "send") {
    const bodyFile = required(flags, "--body-file");
    // A file, not an argument: a body on the command line would land in the
    // process list and in shell history.
    const body = (deps.readBody ?? ((path) => readFileSync(path, "utf8")))(
      bodyFile
    );
    const context = one(flags, "--context");
    const receipt = await sendA2AMessage(
      endpoint,
      {
        body,
        ...(context ? { contextId: context } : {}),
        messageId:
          one(flags, "--message-id") ??
          (deps.newMessageId ?? (() => `a2a-${randomUUID()}`))(),
        to: required(flags, "--to"),
      },
      deps.fetchImpl
    );
    return { action: "send", ...receipt };
  }
  if (action === "status") {
    return {
      action: "status",
      ...(await a2aMessageStatus(
        endpoint,
        required(flags, "--message-id"),
        deps.fetchImpl
      )),
    };
  }
  const result = await acknowledgeA2AWorkflows(
    endpoint,
    flags.values.get("--workflow") ?? [],
    deps.fetchImpl
  );
  if (result.refused.length > 0) {
    throw new Error(
      `ack refused for ${result.refused.map((entry) => `${entry.workflowId} (${entry.reason})`).join(", ")}${result.acknowledged.length > 0 ? `; acknowledged ${result.acknowledged.map((entry) => entry.workflowId).join(", ")}` : ""}`
    );
  }
  return { action: "ack", ...result };
};

/* ---------------------------------------------------------------------------
 * The launch flag. `--a2a-as supervisor:x` (or `--a2a-as=supervisor:x`) is
 * taken out of the launch argv before the launch parser sees it; the paired
 * tmux launch claims the run as that supervisor once its manifest has its
 * session ids.
 * ------------------------------------------------------------------------- */

export const A2A_AS_FLAG = "--a2a-as";

export const extractA2AAsFlag = (
  argv: readonly string[]
): { argv: string[]; supervisorId?: string } => {
  const rest: string[] = [];
  let supervisorId: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    let value: string | undefined;
    if (arg === A2A_AS_FLAG) {
      value = argv[index + 1];
      index++;
    } else if (arg.startsWith(`${A2A_AS_FLAG}=`)) {
      value = arg.slice(A2A_AS_FLAG.length + 1);
    } else {
      rest.push(arg);
      continue;
    }
    if (supervisorId !== undefined) {
      throw new Error(`${A2A_AS_FLAG} given more than once`);
    }
    try {
      supervisorId = requireSupervisorEndpointRecipient(value);
    } catch {
      throw new Error(`Invalid ${A2A_AS_FLAG}: expected supervisor:<name>`);
    }
  }
  return supervisorId === undefined
    ? { argv: rest }
    : { argv: rest, supervisorId };
};

/* ---------------------------------------------------------------------------
 * Bridge session mode: `__bridge-mcp <sessionDir> claude` where sessionDir is
 * `<home>/.loop/sessions/<slug>/<sessionId>` (no run manifest). The bridge
 * then also serves a2a_enroll, a2a_release, a2a_send and a2a_status, acting
 * as `supervisor:<slug>`.
 *
 * The acting supervisor is fixed when the bridge starts, from the session
 * dir its start argv names (the dir `loop a2a enroll` printed), and never
 * from tool input: no tool schema has an identity, token or takeover field,
 * and a call that tries one is refused before anything is read or sent. A
 * takeover is only the human CLI's `loop a2a enroll --takeover`; a
 * multi-token environment is refused here with no override.
 * ------------------------------------------------------------------------- */

export interface A2ABridgeSession {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly supervisorId: string;
}

/** The session this bridge serves, or undefined outside session mode. */
export const a2aBridgeSession = (
  runDir: string,
  source: string,
  env: NodeJS.ProcessEnv = process.env
): A2ABridgeSession | undefined => {
  if (source !== "claude") {
    return undefined;
  }
  let sessionsRoot: string;
  try {
    sessionsRoot = supervisorEndpointRoots(
      env.HOME?.trim() || homedir()
    ).sessionsRoot;
  } catch {
    return undefined;
  }
  const dir = resolve(runDir);
  const segments = relative(sessionsRoot, dir).split(sep);
  const [slug, sessionId] = segments;
  if (
    segments.length !== 2 ||
    !(slug && sessionId) ||
    existsSync(resolve(dir, SUPERVISOR_ENDPOINT_MANIFEST_FILE))
  ) {
    return undefined;
  }
  // The slug and session id must be the same safe segments the server
  // derives the directory from.
  try {
    requireSupervisorEndpointSessionId(sessionId);
    return Object.freeze({
      sessionDir: dir,
      sessionId,
      supervisorId: requireSupervisorEndpointRecipient(
        supervisorIdFromSlug(slug)
      ),
    });
  } catch {
    return undefined;
  }
};

const MUTATING = {
  destructiveHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};

export const A2A_SESSION_TOOLS = [
  {
    annotations: MUTATING,
    description:
      "Enroll this Claude Code session as its supervisor's A2A V2 endpoint (claims the session lease). The supervisor is fixed by this session; credentials stay in the protected environment.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        provider_session: { type: "string" },
        ttl_ms: { type: "number" },
      },
      type: "object",
    },
    name: "a2a_enroll",
  },
  {
    annotations: MUTATING,
    description:
      "Release this session's A2A V2 endpoint lease; new messages fall back to the supervisor's mailbox.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      type: "object",
    },
    name: "a2a_release",
  },
  {
    annotations: MUTATING,
    description:
      "Send an A2A V2 message to another supervisor. Acceptance is not delivery, acknowledgement or completion; check a2a_status.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        context_id: { type: "string" },
        message: { type: "string" },
        message_id: { type: "string" },
        to: { type: "string" },
      },
      required: ["to", "message"],
      type: "object",
    },
    name: "a2a_send",
  },
  {
    annotations: { ...MUTATING, readOnlyHint: true },
    description:
      "Status of a message this supervisor sent: delivery, the recipient's acknowledgement and work completion, reported separately. message_id is the workflowId that a2a_send returned.",
    inputSchema: {
      additionalProperties: false,
      properties: { message_id: { type: "string" } },
      required: ["message_id"],
      type: "object",
    },
    name: "a2a_status",
  },
] as const;

export const A2A_SESSION_TOOL_NAMES: ReadonlySet<string> = new Set(
  A2A_SESSION_TOOLS.map((tool) => tool.name)
);

/**
 * Argument names that would let a tool caller pick who the bridge acts as,
 * with whose token, or over whose lease. No schema has one; a call that
 * sends one is refused by name.
 */
const IDENTITY_ARG_RE =
  /^(?:acting[_-]?as|as|from|identity|impersonate|on[_-]?behalf[_-]?of|principal|sender|supervisor(?:[_-]?id)?|takeover|token(?:[_-]?env)?)$/i;

const exactArgs = (
  args: Record<string, unknown>,
  allowed: readonly string[]
): void => {
  const keys = Object.keys(args);
  if (keys.some((key) => IDENTITY_ARG_RE.test(key))) {
    throw new Error(
      "the acting supervisor is fixed by this session; a tool call cannot choose an identity, token or takeover"
    );
  }
  if (keys.some((key) => !allowed.includes(key))) {
    throw new Error("unexpected tool arguments");
  }
};

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

type A2ASessionTool = (
  args: Record<string, unknown>,
  session: A2ABridgeSession,
  deps: A2ACommandDeps
) => Promise<Record<string, unknown>>;

const enrollTool: A2ASessionTool = async (args, session, deps) => {
  exactArgs(args, ["provider_session", "ttl_ms"]);
  const provider = optionalString(args.provider_session, "provider_session");
  const ttlMs =
    args.ttl_ms === undefined
      ? undefined
      : requireSupervisorEndpointLeaseTtlMs(args.ttl_ms);
  const claimed = await claimChannelA2AEndpoint(
    {
      ...(provider
        ? { providerSessionId: requireSupervisorEndpointSessionId(provider) }
        : {}),
      sessionId: session.sessionId,
      supervisorId: session.supervisorId,
    },
    // Never a takeover from a tool: only the human CLI flag asks for one.
    { ...deps, takeover: false, ttlMs }
  );
  return { receipt: claimed.receipt };
};

const releaseTool: A2ASessionTool = async (args, session, deps) => {
  exactArgs(args, []);
  const recorded = readA2ALeaseRecord(session.sessionDir);
  if (recorded && recorded.supervisorId !== session.supervisorId) {
    throw new Error(`the recorded lease belongs to ${recorded.supervisorId}`);
  }
  const outcome = await releaseRecordedA2ALease(session.sessionDir, deps);
  if (outcome.outcome === "failed") {
    throw new Error(`release failed: ${outcome.detail}`);
  }
  if (outcome.outcome === "none") {
    throw new Error(`no A2A lease is recorded (${A2A_LEASE_RECORD_FILE})`);
  }
  return outcome;
};

const sendTool: A2ASessionTool = async (args, session, deps) => {
  exactArgs(args, ["context_id", "message", "message_id", "to"]);
  const contextId = optionalString(args.context_id, "context_id");
  const messageId =
    optionalString(args.message_id, "message_id") ??
    (deps.newMessageId ?? (() => `a2a-${randomUUID()}`))();
  return {
    ...(await sendA2AMessage(
      resolveA2AClientEndpoint(session.supervisorId, deps),
      {
        body: optionalString(args.message, "message") ?? "",
        ...(contextId ? { contextId } : {}),
        messageId,
        to: optionalString(args.to, "to") ?? "",
      },
      deps.fetchImpl
    )),
  };
};

const statusTool: A2ASessionTool = async (args, session, deps) => {
  exactArgs(args, ["message_id"]);
  return {
    ...(await a2aMessageStatus(
      resolveA2AClientEndpoint(session.supervisorId, deps),
      optionalString(args.message_id, "message_id") ?? "",
      deps.fetchImpl
    )),
  };
};

const SESSION_TOOL_HANDLERS: Readonly<Record<string, A2ASessionTool>> = {
  a2a_enroll: enrollTool,
  a2a_release: releaseTool,
  a2a_send: sendTool,
  a2a_status: statusTool,
};

/** One session-mode tool call. Throws a token-free error on refusal. */
export const callA2ASessionTool = (
  name: string,
  args: Record<string, unknown>,
  session: A2ABridgeSession,
  deps: A2ACommandDeps = {}
): Promise<Record<string, unknown>> => {
  const handler = Object.hasOwn(SESSION_TOOL_HANDLERS, name)
    ? SESSION_TOOL_HANDLERS[name]
    : undefined;
  // A tool never acts from a multi-token environment: there is no human
  // here to have opted in.
  return handler
    ? handler(args, session, { ...deps, allowMultiTokenEnv: false })
    : Promise.reject(new Error(`Unknown tool: ${name}`));
};
