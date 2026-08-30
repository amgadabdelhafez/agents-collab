import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import {
  parseOrchestrationCommand,
  runOrchestrationCommand,
} from "../../src/loop/orchestration-command";

test("orchestration command resolves one config and invokes the server once", async () => {
  const runner = mock(async (_configPath: string) => undefined);
  const handled = await runOrchestrationCommand(
    ["orchestration", "serve", "config/orchestration.json"],
    runner
  );
  expect(handled).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner).toHaveBeenCalledWith(resolve("config/orchestration.json"));
});

test("orchestration command is isolated from ordinary Loop argv", async () => {
  const runner = mock(async (_configPath: string) => undefined);
  expect(await runOrchestrationCommand(["--tmux"], runner)).toBe(false);
  expect(runner).not.toHaveBeenCalled();
});

test("orchestration command refuses incomplete or ambiguous invocation", () => {
  const invalid = [
    ["orchestration"],
    ["orchestration", "start", "/tmp/config.json"],
    ["orchestration", "serve"],
    ["orchestration", "serve", "/tmp/config.json", "extra"],
  ];
  for (const argv of invalid) {
    expect(() => parseOrchestrationCommand(argv)).toThrow(
      "Usage: loop orchestration serve <config-path>"
    );
  }
});
