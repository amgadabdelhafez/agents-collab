import { execFileSync, spawnSync } from "node:child_process";

const BASE = "2848c91e96d1d1d57a1b0b87caea54adc6d134a6";
const CODE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const LOOP_PREFIX = /^loop-fork\//;

const repoRoot = new URL("../../../../", import.meta.url).pathname;
const loopRoot = new URL("../../../", import.meta.url).pathname;
const changed = execFileSync(
  "git",
  [
    "diff",
    "--name-only",
    `${BASE}...HEAD`,
    "--",
    "loop-fork",
    ":(exclude)loop-fork/runs/**",
  ],
  { cwd: repoRoot, encoding: "utf8" }
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((path) => {
    const dot = path.lastIndexOf(".");
    return dot >= 0 && CODE_EXTENSIONS.has(path.slice(dot));
  })
  .map((path) => path.replace(LOOP_PREFIX, ""));

changed.push("runs/webui-integrated-stack-v1/artifacts/verify-integration.mjs");
changed.push("runs/webui-integrated-stack-v1/artifacts/run-scoped-check.mjs");

const unique = [...new Set(changed)].sort();
if (unique.length === 0) {
  throw new Error("scoped static check resolved no files");
}

console.log(`Checking ${unique.length} derived code/config paths`);
const result = spawnSync("bunx", ["ultracite", "check", ...unique], {
  cwd: loopRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
