import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..");

test("root release workflow packages the full-repository Loop layout", () => {
  const workflow = readFileSync(
    join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );

  expect(pkg.version).toBe("1.0.34");
  expect(workflow).toContain("tags:");
  expect(workflow).not.toContain("branches:");
  expect(workflow).toContain("require('./loop-fork/package.json').version");
  expect(workflow).toContain("working-directory: loop-fork");
  for (const asset of [
    "loop-linux-x64",
    "loop-macos-x64",
    "loop-macos-arm64",
    "loop-windows-x64.exe",
  ]) {
    expect(workflow).toContain(`asset_name: ${asset}`);
  }
  expect(workflow).toContain(
    ["loop-fork/$", "{{ matrix.asset_name }}.sha256"].join("")
  );
});
