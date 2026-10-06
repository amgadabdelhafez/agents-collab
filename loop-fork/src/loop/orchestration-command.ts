import { resolve } from "node:path";

const ORCHESTRATION_COMMAND = "orchestration";
const SERVE_COMMAND = "serve";
const RESULT_GRAPH_ID_COMMAND = "result-graph-id";
const USAGE =
  "Usage: loop orchestration serve <config-path> | loop orchestration result-graph-id <config-path> <message-workflow-id>";

export type OrchestrationCommandRequest =
  | { command: "serve"; configPath: string }
  | {
      command: "result-graph-id";
      configPath: string;
      messageWorkflowId: string;
    };

export type OrchestrationServerRunner = (configPath: string) => Promise<void>;

export interface OrchestrationCommandIo {
  /** Where the configured key environment variable is read. */
  env?: NodeJS.ProcessEnv;
  write?(text: string): void;
}

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
  const [messageWorkflowId, ...extra] = rest;
  if (
    command === RESULT_GRAPH_ID_COMMAND &&
    configPath?.trim() &&
    messageWorkflowId?.trim() &&
    extra.length === 0
  ) {
    return {
      command: "result-graph-id",
      configPath: resolve(cwd, configPath),
      messageWorkflowId,
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

export const runOrchestrationCommand = async (
  argv: readonly string[],
  runner: OrchestrationServerRunner = runServer,
  io: OrchestrationCommandIo = {}
): Promise<boolean> => {
  const request = parseOrchestrationCommand(argv);
  if (!request) {
    return false;
  }
  if (request.command === "result-graph-id") {
    // Only the derived id is printed; the key never leaves the environment.
    const graphWorkflowId = await deriveFromConfig(
      request.configPath,
      request.messageWorkflowId,
      io.env ?? process.env
    );
    (io.write ?? ((text: string) => process.stdout.write(text)))(
      `${graphWorkflowId}\n`
    );
    return true;
  }
  await runner(request.configPath);
  return true;
};
