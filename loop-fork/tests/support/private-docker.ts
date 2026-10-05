import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Task-owned test process adapter. Secret values travel in env, never argv. */
export const privateDocker = async (
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<string> => {
  try {
    return (
      await execute("docker", args, {
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 30_000,
      })
    ).stdout.trim();
  } catch {
    // execFile errors embed commands/output; do not let operational secrets
    // escape into test reporters after an infrastructure failure.
    throw new Error("task-owned Docker operation failed");
  }
};
