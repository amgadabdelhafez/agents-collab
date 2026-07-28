import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const BASELINE_GATE = join(REPO_ROOT, "scripts/check-baseline-allowlist.py");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts/verify.sh");

const runGate = (document: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "baseline-gate-"));
  const evalPath = join(root, "eval.json");
  writeFileSync(evalPath, JSON.stringify(document));
  try {
    return spawnSync(["python3", BASELINE_GATE, evalPath]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
};

test("project verifier fails closed without task identity", () => {
  const result = spawnSync(["bash", VERIFY_SCRIPT]);
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("a task id is required");
});

test("baseline gate accepts only a passing eval with an empty named list", () => {
  const result = runGate({ baseline_failures: [], verdict: "pass" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("baseline allowlist empty");
});

test.each([
  { baseline_failures: ["tests/example.test.ts"], verdict: "pass" },
  { baseline_failed: 4, baseline_failures: [], verdict: "pass" },
  { baseline_failures: true, verdict: "pass" },
  { baseline_failures: [], status: "baseline_failures_only", verdict: "pass" },
  { baseline_failures: [], verdict: "pending" },
])("baseline gate rejects legacy or unresolved allowance %#", (document) => {
  const result = runGate(document);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("baseline gate failed");
});
