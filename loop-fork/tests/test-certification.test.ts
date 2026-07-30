import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("direct bun test fails before executing a partial suite", () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "LOOP_TEST_CERTIFICATION_MODE"
    )
  );

  const result = spawnSync(
    process.execPath,
    ["test", "tests/loop/utils.test.ts"],
    { cwd: process.cwd(), encoding: "utf8", env }
  );

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("direct `bun test` is unsupported");
  expect(result.stderr).toContain("bun run test:ci");
  expect(result.stdout).not.toContain("(pass)");
});
