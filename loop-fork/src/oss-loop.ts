#!/usr/bin/env bun
import { runCli } from "./cli";

const main = async (): Promise<void> => {
  await runCli(["--oss-only", ...process.argv.slice(2)]);
};

if (import.meta.main) {
  main();
}
