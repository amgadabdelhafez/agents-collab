import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "bun";
import { readBridgeStatus } from "./bridge-store";

const FILE = "claude-channel-readiness.json";
const MAX_AGE_MS = 10_000;

// Transient transport observation only. SQL owns enrolled session identity.
// This contains no messages, credentials or task state and is safe to rebuild.
export const publishClaudeChannelReadiness = (
  runDir: string,
  identity: {
    claudeSessionId: string;
    claudeChannelServer: string;
  }
): void => {
  const status = readBridgeStatus(runDir);
  if (
    !(status.claudeSessionId && status.claudeChannelServer) ||
    status.claudeSessionId !== identity.claudeSessionId ||
    status.claudeChannelServer !== identity.claudeChannelServer
  ) {
    return;
  }
  const destination = join(runDir, FILE);
  const temporary = `${destination}.${process.pid}`;
  writeFileSync(
    temporary,
    JSON.stringify({
      schema: "loop-claude-channel-ready.v1",
      sessionId: status.claudeSessionId,
      channel: status.claudeChannelServer,
      pid: process.pid,
      at: Date.now(),
    }),
    { mode: 0o600 }
  );
  renameSync(temporary, destination);
};

export const clearClaudeChannelReadiness = (runDir: string): void => {
  try {
    const path = join(runDir, FILE);
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current.pid === process.pid) {
      rmSync(path);
    }
  } catch {
    // Missing or replacement-owned observations are not ours to remove.
  }
};

export const probeClaudeChannelReadiness = (
  runDir: string,
  options: { now?: number; commandForPid?: (pid: number) => string } = {}
): boolean => {
  try {
    const receipt = JSON.parse(readFileSync(join(runDir, FILE), "utf8"));
    const status = readBridgeStatus(runDir);
    const age = (options.now ?? Date.now()) - receipt.at;
    if (
      receipt.schema !== "loop-claude-channel-ready.v1" ||
      !Number.isSafeInteger(receipt.pid) ||
      receipt.pid <= 0 ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > MAX_AGE_MS ||
      !status.claudeSessionId ||
      !status.claudeChannelServer ||
      receipt.sessionId !== status.claudeSessionId ||
      receipt.channel !== status.claudeChannelServer
    ) {
      return false;
    }
    const command = options.commandForPid
      ? options.commandForPid(receipt.pid)
      : new TextDecoder()
          .decode(
            spawnSync(["ps", "-p", String(receipt.pid), "-o", "command="], {
              stdout: "pipe",
              stderr: "ignore",
            }).stdout
          )
          .trim();
    // Exact run argument and source seat, not a generic live PID or pane.
    return command.includes(`__bridge-mcp ${runDir} claude`);
  } catch {
    return false;
  }
};
