import { userInfo } from "node:os";
import { resolve } from "node:path";

const ORCHESTRATION_COMMAND = "orchestration";
const SERVE_COMMAND = "serve";
const RESULT_GRAPH_ID_COMMAND = "result-graph-id";
const QUARANTINE_COMMAND = "v2-quarantine";
const RELEASE_COMMAND = "v2-quarantine-release";
const LIST_COMMAND = "v2-quarantine-list";
const USAGE = [
  "Usage: loop orchestration serve <config-path>",
  "loop orchestration result-graph-id <config-path> <message-workflow-id>",
  "loop orchestration v2-quarantine <config-path> <workflow-id> --reason <text> [--by <operator>]",
  "loop orchestration v2-quarantine-release <config-path> <workflow-id> --reason <text> [--by <operator>]",
  "loop orchestration v2-quarantine-list <config-path>",
].join(" | ");

export type OrchestrationCommandRequest =
  | { command: "serve"; configPath: string }
  | {
      command: "result-graph-id";
      configPath: string;
      messageWorkflowId: string;
    }
  | {
      /** Defaults to the operating-system user running the command. */
      by?: string;
      command: "v2-quarantine" | "v2-quarantine-release";
      configPath: string;
      reason: string;
      workflowId: string;
    }
  | { command: "v2-quarantine-list"; configPath: string };

export type OrchestrationServerRunner = (configPath: string) => Promise<void>;

export interface OrchestrationCommandIo {
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

export const parseOrchestrationCommand = (
  argv: readonly string[],
  cwd = process.cwd()
): OrchestrationCommandRequest | undefined => {
  if (argv[0] !== ORCHESTRATION_COMMAND) {
    return undefined;
  }
  const [command, configPath, ...rest] = argv.slice(1);
  if (command === SERVE_COMMAND && configPath?.trim() && rest.length === 0) {
    return { command: "serve", configPath: resolve(cwd, configPath) };
  }
  if (command === LIST_COMMAND && configPath?.trim() && rest.length === 0) {
    return {
      command: "v2-quarantine-list",
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
