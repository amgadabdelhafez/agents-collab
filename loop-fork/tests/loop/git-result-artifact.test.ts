import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
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

test("result artifact verification bounds concurrent git subprocesses", async () => {
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
  // Each git call marks itself active, records how many are active at once,
  // and holds its slot long enough for an uncapped burst to overlap.
  const fakeBin = mkdtempSync(join(tmpdir(), "git-result-artifact-cap-"));
  const active = join(fakeBin, "active");
  const peaks = join(fakeBin, "peaks");
  mkdirSync(active);
  writeFileSync(
    join(fakeBin, "git"),
    [
      "#!/bin/sh",
      `touch '${active}'/$$`,
      `ls '${active}' | wc -l >> '${peaks}'`,
      "sleep 0.2",
      `rm -f '${active}'/$$`,
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n")
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  try {
    const verify = createGitResultArtifactVerifier([
      { repositoryRoot, commit, path, artifactRef },
    ]);
    const burst = 12;
    const results = await Promise.all(
      Array.from({ length: burst }, () => verify(artifactRef))
    );
    // Same verdicts as an unbounded run: every request still verifies.
    expect(results).toEqual(Array.from({ length: burst }, () => true));
    const observed = readFileSync(peaks, "utf8")
      .trim()
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10));
    expect(observed).toHaveLength(burst * 3);
    // At most four git subprocesses at once, but still more than one.
    expect(Math.max(...observed)).toBeLessThanOrEqual(4);
    expect(Math.max(...observed)).toBeGreaterThan(1);
  } finally {
    process.env.PATH = originalPath;
    rmSync(fakeBin, { force: true, recursive: true });
  }
}, 30_000);

test("failed git calls release their concurrency slot", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repositoryRoot, ...args]);
  const commit = git(["rev-parse", "HEAD"]).toString().trim();
  const path = "loop-fork/src/loop/workflow-port.ts";
  const bytes = git(["show", `${commit}:${path}`]);
  const artifactRef = `artifact://sha256/${createHash("sha256").update(bytes).digest("hex")}`;
  const missingRef = `artifact://sha256/${"2".repeat(64)}`;
  const verify = createGitResultArtifactVerifier([
    { repositoryRoot, commit, path, artifactRef },
    { repositoryRoot, commit: "0".repeat(40), path, artifactRef: missingRef },
  ]);
  // More failing git calls than there are slots; a leaked slot would leave
  // the final verification queued forever.
  expect(
    await Promise.all(Array.from({ length: 10 }, () => verify(missingRef)))
  ).toEqual(Array.from({ length: 10 }, () => false));
  const settled = await Promise.race([
    verify(artifactRef),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still-queued"), 5000)
    ),
  ]);
  expect(settled).toBe(true);
}, 15_000);
