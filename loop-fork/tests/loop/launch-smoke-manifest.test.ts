import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "bun";

const resolver = join(
  process.cwd(),
  "..",
  "evals",
  "smoke",
  "resolve-single-manifest.sh"
);

const resolveManifest = (home: string) =>
  spawnSync(["bash", resolver, home, "repo-test"], {
    stderr: "pipe",
    stdout: "pipe",
  });

const writeManifest = (home: string, runId: string): string => {
  const path = join(home, ".loop", "runs", "repo-test", runId, "manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ repoId: "repo-test", runId })}\n`);
  return path;
};

test("release smoke manifest discovery fails closed unless one producer manifest exists", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-smoke-manifest-"));
  try {
    const absent = resolveManifest(home);
    expect(absent.exitCode).toBe(1);
    expect(absent.stdout.toString()).toBe("");
    expect(absent.stderr.toString()).toContain("found 0");

    const expected = writeManifest(home, "1");
    const single = resolveManifest(home);
    expect(single.exitCode).toBe(0);
    expect(single.stdout.toString().trim()).toBe(expected);
    expect(single.stderr.toString()).toBe("");

    writeManifest(home, "2");
    const ambiguous = resolveManifest(home);
    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stdout.toString()).toBe("");
    expect(ambiguous.stderr.toString()).toContain("found 2");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
