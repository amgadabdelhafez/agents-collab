import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { which } from "bun";
import { createGitResultArtifactVerifier } from "../../src/loop/git-result-artifact";

test("result artifacts verify exact committed bytes and refuse arbitrary refs and mutable paths", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const git = (args: string[]) =>
    execFileSync("git", [
      "--no-replace-objects",
      "-C",
      repositoryRoot,
      ...args,
    ]);
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const path = "loop-fork/src/loop/workflow-port.ts";
  const bytes = git(["show", `${commit}:${path}`]);
  const artifactRef = `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`;
  const binding = { repositoryRoot, commit, path, artifactRef };
  expect(await createGitResultArtifactVerifier([binding])(artifactRef)).toBe(
    true
  );
  expect(
    await createGitResultArtifactVerifier([binding])(
      `artifact://sha256/${"0".repeat(64)}`
    )
  ).toBe(false);
  const wrong = `artifact://sha256/${"1".repeat(64)}`;
  expect(
    await createGitResultArtifactVerifier([{ ...binding, artifactRef: wrong }])(
      wrong
    )
  ).toBe(false);
  expect(
    await createGitResultArtifactVerifier([
      { ...binding, commit: "0".repeat(40) },
    ])(artifactRef)
  ).toBe(false);
  expect(() =>
    createGitResultArtifactVerifier([{ ...binding, commit: "HEAD" }])
  ).toThrow();
  expect(() =>
    createGitResultArtifactVerifier([{ ...binding, path: "../secret" }])
  ).toThrow();
  expect(() => createGitResultArtifactVerifier([binding, binding])).toThrow();
});

test("result artifact verification runs git without blocking the event loop", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const realGit = which("git");
  expect(realGit).toBeTruthy();
  const commit = execFileSync("git", [
    "-C",
    repositoryRoot,
    "rev-parse",
    "HEAD",
  ])
    .toString()
    .trim();
  const path = "loop-fork/src/loop/workflow-port.ts";
  const bytes = execFileSync("git", [
    "-C",
    repositoryRoot,
    "show",
    `${commit}:${path}`,
  ]);
  const artifactRef = `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`;
  // A slow git on PATH: each call sleeps before running the real git, and
  // records that it was used.
  const fakeBin = mkdtempSync(join(tmpdir(), "git-result-artifact-"));
  const calls = join(fakeBin, "calls");
  writeFileSync(
    join(fakeBin, "git"),
    `#!/bin/sh\necho call >> '${calls}'\nsleep 0.3\nexec '${realGit}' "$@"\n`
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const verify = createGitResultArtifactVerifier([
      { repositoryRoot, commit, path, artifactRef },
    ]);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 25);
    const started = performance.now();
    const pending = verify(artifactRef);
    const returnedAfterMs = performance.now() - started;
    const verified = await pending;
    clearInterval(timer);
    expect(verified).toBe(true);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(3);
    // The request path must get its promise back immediately, and other work
    // must keep running while the three slow git calls are in flight.
    expect(returnedAfterMs).toBeLessThan(150);
    expect(ticks).toBeGreaterThan(5);
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeBin, { force: true, recursive: true });
  }
});
