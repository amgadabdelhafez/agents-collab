#!/usr/bin/env bun
import { runLoopOrchestrationServer } from "./loop/loop-orchestration-server";

const [configPath] = process.argv.slice(2);
if (!configPath) {
  throw new Error("Usage: bun run src/orchestration-cli.ts <config-path>");
}
await runLoopOrchestrationServer(configPath);
