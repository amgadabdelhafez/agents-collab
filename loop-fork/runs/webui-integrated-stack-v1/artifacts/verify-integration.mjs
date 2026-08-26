import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "2848c91e96d1d1d57a1b0b87caea54adc6d134a6";
const T01_HEAD = "0687932713aa59452d65a7d85e7751981c6de64d";
const MOBILE_HEAD = "6c9598b550354cb91fbc10887ab7549d47b8169e";
const FIRST_MERGE = "32f2c82";
const SECOND_MERGE = "7b5b5d0";
const TASKS_PATH = "loop-fork/.harness/tasks.json";
const DEBT_PATH = "loop-fork/debt/register.jsonl";
const COMPONENT_TASKS = new Map([
  ["webui-theme-mode", MOBILE_HEAD],
  ["webui-mobile-tailscale", MOBILE_HEAD],
  ["webui-t00-adapter-identity-v2", T01_HEAD],
  ["webui-t01-read-model-v2", T01_HEAD],
]);

const repoRoot = resolve(process.cwd(), "..");

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readCommit(sha, path) {
  return git(["show", `${sha}:${path}`]);
}

function parseDebt(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ line, value: JSON.parse(line) }));
}

function multiset(lines) {
  const counts = new Map();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

for (const sha of [BASE, T01_HEAD, MOBILE_HEAD]) {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
}

const currentTasksText = readFileSync(resolve(repoRoot, TASKS_PATH), "utf8");
const currentTasks = JSON.parse(currentTasksText).tasks;
const taskCounts = new Map();
for (const task of currentTasks) {
  taskCounts.set(task.id, (taskCounts.get(task.id) ?? 0) + 1);
}
assert(
  [...taskCounts.values()].every((count) => count === 1),
  "task registry contains a duplicate task id"
);

for (const [taskId, parent] of COMPONENT_TASKS) {
  const parentTask = JSON.parse(readCommit(parent, TASKS_PATH)).tasks.find(
    (task) => task.id === taskId
  );
  const currentTask = currentTasks.find((task) => task.id === taskId);
  assert(parentTask, `parent task missing: ${taskId}`);
  assert(currentTask, `integrated task missing: ${taskId}`);
  assert(
    JSON.stringify(currentTask) === JSON.stringify(parentTask),
    `integrated task changed: ${taskId}`
  );
}
assert(
  taskCounts.get("webui-integrated-stack-v1") === 1,
  "active integration task must occur exactly once"
);

const expectedDebtLines = [];
for (const parent of [T01_HEAD, MOBILE_HEAD]) {
  for (const row of parseDebt(readCommit(parent, DEBT_PATH))) {
    if (COMPONENT_TASKS.has(row.value.task_id)) {
      expectedDebtLines.push(row.line);
    }
  }
}
const currentDebtRows = parseDebt(
  readFileSync(resolve(repoRoot, DEBT_PATH), "utf8")
).filter((row) => COMPONENT_TASKS.has(row.value.task_id));
const expectedDebt = multiset(expectedDebtLines);
const actualDebt = multiset(currentDebtRows.map((row) => row.line));
assert(expectedDebt.size === actualDebt.size, "component debt row set changed");
for (const [line, count] of expectedDebt) {
  assert(actualDebt.get(line) === count, `component debt row changed: ${line}`);
}

for (const [commit, allowed] of [
  [FIRST_MERGE, [TASKS_PATH]],
  [SECOND_MERGE, [TASKS_PATH, DEBT_PATH]],
]) {
  const resolved = git([
    "diff-tree",
    "--cc",
    "--no-commit-id",
    "--name-only",
    "-r",
    commit,
  ])
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert(
    JSON.stringify(resolved) === JSON.stringify([...allowed].sort()),
    `${commit} resolved unexpected paths: ${resolved.join(", ")}`
  );
}

const conflictMarker = /^(<<<<<<<|=======|>>>>>>>)/m;
assert(
  !conflictMarker.test(currentTasksText),
  "task registry has conflict markers"
);
assert(
  !conflictMarker.test(readFileSync(resolve(repoRoot, DEBT_PATH), "utf8")),
  "debt registry has conflict markers"
);

execFileSync(
  "git",
  [
    "diff",
    "--check",
    `${BASE}...HEAD`,
    "--",
    ".",
    ":(exclude)loop-fork/runs/**",
  ],
  {
    cwd: repoRoot,
    stdio: "ignore",
  }
);

console.log(
  JSON.stringify(
    {
      status: "pass",
      base: BASE,
      parents: [T01_HEAD, MOBILE_HEAD],
      merge_resolutions: {
        [FIRST_MERGE]: [TASKS_PATH],
        [SECOND_MERGE]: [TASKS_PATH, DEBT_PATH],
      },
      component_task_rows: COMPONENT_TASKS.size,
      component_debt_rows: expectedDebtLines.length,
    },
    null,
    2
  )
);
