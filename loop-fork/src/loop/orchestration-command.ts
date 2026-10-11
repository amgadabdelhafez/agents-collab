import { userInfo } from "node:os";
import { resolve } from "node:path";

const ORCHESTRATION_COMMAND = "orchestration";
const SERVE_COMMAND = "serve";
const RESULT_GRAPH_ID_COMMAND = "result-graph-id";
const RESULT_GRAPH_KEY_FINGERPRINTS_COMMAND = "result-graph-key-fingerprints";
const QUARANTINE_COMMAND = "v2-quarantine";
const RELEASE_COMMAND = "v2-quarantine-release";
const LIST_COMMAND = "v2-quarantine-list";
const A2A_V2_COMMAND = "a2a-v2";
const TOKEN_KEYGEN_USAGE = "loop orchestration token-keygen <config-path>";
const TOKEN_CODE_USAGE =
  "loop orchestration token-code <config-path> <supervisor-id> --out <new-file>";
const TOKEN_REVOKE_USAGE =
  "loop orchestration token-revoke <config-path> (--session <session-id> | --jti <jti> | --epoch <supervisor-id>)";
const REVOKE_FLAGS: Readonly<Record<string, string>> = {
  "--epoch": "epochFor",
  "--jti": "jti",
  "--session": "sessionId",
};
const A2A_V2_INIT_USAGE =
  "loop orchestration a2a-v2 init <config-path> [--control <supervisor-id>] [--recipient <supervisor-id>] [--manifest <supervisor-id>=<path>]... [--ledger-name <name>] [--ledger-port <port>] [--database-url-env <NAME>]";
const USAGE = [
  "Usage: loop orchestration serve <config-path>",
  A2A_V2_INIT_USAGE,
  "loop orchestration result-graph-id <config-path> <message-workflow-id>",
  "loop orchestration result-graph-key-fingerprints <config-path>",
  "loop orchestration v2-quarantine <config-path> <workflow-id> --reason <text> [--by <operator>]",
  "loop orchestration v2-quarantine-release <config-path> <workflow-id> --reason <text> [--by <operator>]",
  "loop orchestration v2-quarantine-list <config-path>",
  TOKEN_KEYGEN_USAGE,
  TOKEN_CODE_USAGE,
  TOKEN_REVOKE_USAGE,
].join(" | ");

export type OrchestrationCommandRequest =
  | { command: "serve"; configPath: string }
  | (import("./loop-orchestration-server").TokenHostCommand & {
      configPath: string;
    })
  | {
      command: "result-graph-id";
      configPath: string;
      messageWorkflowId: string;
    }
  | { command: "result-graph-key-fingerprints"; configPath: string }
  | {
      /** Defaults to the operating-system user running the command. */
      by?: string;
      command: "v2-quarantine" | "v2-quarantine-release";
      configPath: string;
      reason: string;
      workflowId: string;
    }
  | { command: "v2-quarantine-list"; configPath: string }
  | {
      command: "a2a-v2-init";
      configPath: string;
      containerName?: string;
      /** r9 (no --manifest, no --recipient): the control principal's supervisor. */
      controlSupervisor?: string;
      databaseUrlEnv?: string;
      ledgerPort?: number;
      manifests: Record<string, string>;
      recipient?: string;
    };

const INIT_VALUE_FLAGS = new Set([
  "--control",
  "--database-url-env",
  "--ledger-name",
  "--ledger-port",
  "--manifest",
  "--recipient",
]);

/** `a2a-v2 init` flags; every one but --manifest at most once. */
const parseA2AV2Init = (
  configPath: string,
  args: readonly string[]
): Extract<OrchestrationCommandRequest, { command: "a2a-v2-init" }> => {
  const single = new Map<string, string>();
  const manifests: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? "";
    const value = args[index + 1];
    if (
      !(INIT_VALUE_FLAGS.has(name) && value?.trim()) ||
      value.startsWith("--")
    ) {
      throw new Error(`Usage: ${A2A_V2_INIT_USAGE}`);
    }
    if (name === "--manifest") {
      const equals = value.indexOf("=");
      const id = equals > 0 ? value.slice(0, equals) : "";
      if (!id || id in manifests) {
        throw new Error(`Usage: ${A2A_V2_INIT_USAGE}`);
      }
      manifests[id] = value.slice(equals + 1);
      continue;
    }
    if (single.has(name)) {
      throw new Error(`Usage: ${A2A_V2_INIT_USAGE}`);
    }
    single.set(name, value);
  }
  return initRequest(configPath, single, manifests);
};

const initRequest = (
  configPath: string,
  single: ReadonlyMap<string, string>,
  manifests: Record<string, string>
): Extract<OrchestrationCommandRequest, { command: "a2a-v2-init" }> => {
  const port = single.get("--ledger-port");
  const named = (flag: string, key: string) =>
    single.has(flag) ? { [key]: single.get(flag) } : {};
  return {
    command: "a2a-v2-init",
    configPath,
    ...named("--ledger-name", "containerName"),
    ...named("--control", "controlSupervisor"),
    ...named("--database-url-env", "databaseUrlEnv"),
    ...(port === undefined ? {} : { ledgerPort: Number(port) }),
    manifests,
    ...named("--recipient", "recipient"),
  };
};

export type OrchestrationServerRunner = (configPath: string) => Promise<void>;

export interface OrchestrationCommandIo {
  /** Test seam for `a2a-v2 init`: replaces the real Docker, probe and clock. */
  a2aV2InitDeps?: Partial<import("./a2a-v2-init").A2AV2InitDeps>;
  /** Where the configured key and database environment variables are read. */
  env?: NodeJS.ProcessEnv;
  write?(text: string): void;
}

/** `--reason <text>` exactly once, `--by <operator>` at most once. */
const parseOperatorFlags = (
  args: readonly string[]
): { by?: string; reason: string } | undefined => {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      (name !== "--reason" && name !== "--by") ||
      !value?.trim() ||
      flags.has(name)
    ) {
      return undefined;
    }
    flags.set(name, value);
  }
  const reason = flags.get("--reason");
  return reason === undefined ? undefined : { by: flags.get("--by"), reason };
};

/** RA1 host token commands; undefined for any other command. */
const parseTokenCommand = (
  command: string | undefined,
  configPath: string | undefined,
  rest: readonly string[],
  cwd: string
): OrchestrationCommandRequest | undefined => {
  if (!command?.startsWith("token-")) {
    return undefined;
  }
  if (!configPath?.trim() || configPath.startsWith("-")) {
    throw new Error(USAGE);
  }
  const path = resolve(cwd, configPath);
  if (command === "token-keygen" && rest.length === 0) {
    return { command, configPath: path };
  }
  const [first, flag, value, ...extra] = rest;
  if (
    command === "token-code" &&
    first?.trim() &&
    !first.startsWith("-") &&
    flag === "--out" &&
    value?.trim() &&
    extra.length === 0
  ) {
    return {
      command,
      configPath: path,
      out: resolve(cwd, value),
      supervisorId: first,
    };
  }
  const key = first === undefined ? undefined : REVOKE_FLAGS[first];
  if (
    command === "token-revoke" &&
    key &&
    flag?.trim() &&
    !flag.startsWith("-") &&
    value === undefined
  ) {
    return {
      command,
      configPath: path,
      target: {
        [key]: flag,
      } as import("./orchestration-token-service").TokenRevocation,
    };
  }
  throw new Error(USAGE);
};

export const parseOrchestrationCommand = (
  argv: readonly string[],
  cwd = process.cwd()
): OrchestrationCommandRequest | undefined => {
  if (argv[0] !== ORCHESTRATION_COMMAND) {
    return undefined;
  }
  const [command, configPath, ...rest] = argv.slice(1);
  const token = parseTokenCommand(command, configPath, rest, cwd);
  if (token) {
    return token;
  }
  if (command === A2A_V2_COMMAND) {
    const [initConfig, ...initArgs] = rest;
    if (
      configPath !== "init" ||
      !initConfig?.trim() ||
      initConfig.startsWith("--")
    ) {
      throw new Error(`Usage: ${A2A_V2_INIT_USAGE}`);
    }
    return parseA2AV2Init(resolve(cwd, initConfig), initArgs);
  }
  if (command === SERVE_COMMAND && configPath?.trim() && rest.length === 0) {
    return { command: "serve", configPath: resolve(cwd, configPath) };
  }
  if (command === LIST_COMMAND && configPath?.trim() && rest.length === 0) {
    return {
      command: "v2-quarantine-list",
      configPath: resolve(cwd, configPath),
    };
  }
  if (
    command === RESULT_GRAPH_KEY_FINGERPRINTS_COMMAND &&
    configPath?.trim() &&
    rest.length === 0
  ) {
    return {
      command: "result-graph-key-fingerprints",
      configPath: resolve(cwd, configPath),
    };
  }
  const [workflowId, ...extra] = rest;
  if (
    command === RESULT_GRAPH_ID_COMMAND &&
    configPath?.trim() &&
    workflowId?.trim() &&
    extra.length === 0
  ) {
    return {
      command: "result-graph-id",
      configPath: resolve(cwd, configPath),
      messageWorkflowId: workflowId,
    };
  }
  const note = parseOperatorFlags(extra);
  if (
    (command === QUARANTINE_COMMAND || command === RELEASE_COMMAND) &&
    configPath?.trim() &&
    workflowId?.trim() &&
    !workflowId.startsWith("-") &&
    note
  ) {
    return {
      by: note.by,
      command,
      configPath: resolve(cwd, configPath),
      reason: note.reason,
      workflowId,
    };
  }
  throw new Error(USAGE);
};

const runServer: OrchestrationServerRunner = async (configPath) => {
  const { runLoopOrchestrationServer } = await import(
    "./loop-orchestration-server"
  );
  await runLoopOrchestrationServer(configPath);
};

const deriveFromConfig = async (
  configPath: string,
  messageWorkflowId: string,
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const { resultGraphWorkflowIdForConfig } = await import(
    "./loop-orchestration-server"
  );
  return resultGraphWorkflowIdForConfig(configPath, messageWorkflowId, env);
};

/** Quarantine, release or list V2 recovery records of the config's ledger. */
const runRecoveryQuarantine = async (
  request: Extract<
    OrchestrationCommandRequest,
    {
      command: "v2-quarantine" | "v2-quarantine-release" | "v2-quarantine-list";
    }
  >,
  env: NodeJS.ProcessEnv
): Promise<string[]> => {
  const { recoveryQuarantineForConfig } = await import(
    "./loop-orchestration-server"
  );
  return recoveryQuarantineForConfig(
    request.configPath,
    request.command === "v2-quarantine-list"
      ? { command: request.command }
      : {
          by: request.by ?? userInfo().username,
          command: request.command,
          reason: request.reason,
          workflowId: request.workflowId,
        },
    env
  );
};

export const runOrchestrationCommand = async (
  argv: readonly string[],
  runner: OrchestrationServerRunner = runServer,
  io: OrchestrationCommandIo = {}
): Promise<boolean> => {
  const request = parseOrchestrationCommand(argv);
  if (!request) {
    return false;
  }
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  if (request.command === "a2a-v2-init") {
    // Paths, names, ports and variable names only; never a secret.
    const { defaultA2AV2InitDeps, runA2AV2Init } = await import(
      "./a2a-v2-init"
    );
    const { command: _command, ...options } = request;
    await runA2AV2Init(options, {
      ...defaultA2AV2InitDeps(),
      ...(io.env ? { env: io.env } : {}),
      log: (line) => write(`${line}\n`),
      ...io.a2aV2InitDeps,
    });
    return true;
  }
  if (request.command === "result-graph-key-fingerprints") {
    // One line per configured key: variable, role, fingerprint. Never a key.
    const { resultGraphKeyFingerprintsForConfig } = await import(
      "./loop-orchestration-server"
    );
    for (const entry of resultGraphKeyFingerprintsForConfig(
      request.configPath,
      io.env ?? process.env
    )) {
      write(`${entry.env} ${entry.role} ${entry.fingerprint}\n`);
    }
    return true;
  }
  if (
    request.command === "token-keygen" ||
    request.command === "token-code" ||
    request.command === "token-revoke"
  ) {
    // Paths, ids and times only: a code goes to its 0600 file.
    const { tokenHostCommandForConfig } = await import(
      "./loop-orchestration-server"
    );
    const { configPath, ...command } = request;
    for (const line of tokenHostCommandForConfig(configPath, command)) {
      write(`${line}\n`);
    }
    return true;
  }
  if (request.command === "result-graph-id") {
    // Only the derived id is printed; the key never leaves the environment.
    const graphWorkflowId = await deriveFromConfig(
      request.configPath,
      request.messageWorkflowId,
      io.env ?? process.env
    );
    write(`${graphWorkflowId}\n`);
    return true;
  }
  if (request.command !== "serve") {
    // Ids, recipient, who, when and why only; never the database URL.
    for (const line of await runRecoveryQuarantine(
      request,
      io.env ?? process.env
    )) {
      write(`${line}\n`);
    }
    return true;
  }
  await runner(request.configPath);
  return true;
};
