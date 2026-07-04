#!/usr/bin/env bun
import { runCli } from "./cli";

const main = async (): Promise<void> => {
  await runCli(["--copilot-only", ...process.argv.slice(2)]);
};

if (import.meta.main) {
  main();
}
