import { resolve } from "node:path";

const ORCHESTRATION_COMMAND = "orchestration";
const SERVE_COMMAND = "serve";
const USAGE = "Usage: loop orchestration serve <config-path>";

export interface OrchestrationServeRequest {
  configPath: string;
}

export type OrchestrationServerRunner = (configPath: string) => Promise<void>;

export const parseOrchestrationCommand = (
  argv: readonly string[],
  cwd = process.cwd()
): OrchestrationServeRequest | undefined => {
  if (argv[0] !== ORCHESTRATION_COMMAND) {
    return undefined;
  }
  const [command, configPath, ...extra] = argv.slice(1);
  if (command !== SERVE_COMMAND || !configPath?.trim() || extra.length !== 0) {
    throw new Error(USAGE);
  }
  return { configPath: resolve(cwd, configPath) };
};

const runServer: OrchestrationServerRunner = async (configPath) => {
  const { runLoopOrchestrationServer } = await import(
    "./loop-orchestration-server"
  );
  await runLoopOrchestrationServer(configPath);
};

export const runOrchestrationCommand = async (
  argv: readonly string[],
  runner: OrchestrationServerRunner = runServer
): Promise<boolean> => {
  const request = parseOrchestrationCommand(argv);
  if (!request) {
    return false;
  }
  await runner(request.configPath);
  return true;
};
