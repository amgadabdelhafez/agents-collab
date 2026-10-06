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
  const target = { graphWorkflowId: "graph:one", graphTaskId: "node:one" };
  const binding = { repositoryRoot, commit, path, artifactRef, ...target };
  expect(
    await createGitResultArtifactVerifier([binding])(artifactRef, target)
  ).toBe(true);
  expect(
    await createGitResultArtifactVerifier([binding])(
      `artifact://sha256/${"0".repeat(64)}`,
      target
    )
  ).toBe(false);
  const wrong = `artifact://sha256/${"1".repeat(64)}`;
  expect(
    await createGitResultArtifactVerifier([{ ...binding, artifactRef: wrong }])(
      wrong,
      target
    )
  ).toBe(false);
  expect(
    await createGitResultArtifactVerifier([
      { ...binding, commit: "0".repeat(40) },
    ])(artifactRef, target)
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
  const target = { graphWorkflowId: "graph:one", graphTaskId: "node:one" };
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
      { repositoryRoot, commit, path, artifactRef, ...target },
    ]);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 25);
    const started = performance.now();
    const pending = verify(artifactRef, target);
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

test("a verified artifact is accepted only for the graph task it is bound to", async () => {
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
  const target = { graphWorkflowId: "graph:one", graphTaskId: "node:one" };
  const verify = createGitResultArtifactVerifier([
    { repositoryRoot, commit, path, artifactRef, ...target },
  ]);
  expect(await verify(artifactRef, target)).toBe(true);
  // Another task's verified artifact is not evidence for this task.
  expect(
    await verify(artifactRef, { ...target, graphTaskId: "node:other" })
  ).toBe(false);
  expect(
    await verify(artifactRef, { ...target, graphWorkflowId: "graph:other" })
  ).toBe(false);
  // An allowlist entry that does not name its task is refused outright.
  expect(() =>
    createGitResultArtifactVerifier([
      { repositoryRoot, commit, path, artifactRef },
    ] as never)
  ).toThrow();
  expect(() =>
    createGitResultArtifactVerifier([
      { repositoryRoot, commit, path, artifactRef, ...target, graphTaskId: "" },
    ])
  ).toThrow();
});

test("byte-identical evidence may be allowlisted for two graph tasks and verifies for each only", async () => {
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
  const one = { graphWorkflowId: "graph:one", graphTaskId: "node:one" };
  const two = { graphWorkflowId: "graph:two", graphTaskId: "node:two" };
  const verify = createGitResultArtifactVerifier([
    { repositoryRoot, commit, path, artifactRef, ...one },
    { repositoryRoot, commit, path, artifactRef, ...two },
  ]);
  expect(await verify(artifactRef, one)).toBe(true);
  expect(await verify(artifactRef, two)).toBe(true);
  expect(await verify(artifactRef, { ...one, graphTaskId: "node:two" })).toBe(
    false
  );
  // The same artifact named twice for the same graph task is still refused.
  expect(() =>
    createGitResultArtifactVerifier([
      { repositoryRoot, commit, path, artifactRef, ...one },
      { repositoryRoot, commit, path, artifactRef, ...one },
    ])
  ).toThrow();
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
  const target = { graphWorkflowId: "graph:cap", graphTaskId: "node:cap" };
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
      { repositoryRoot, commit, path, artifactRef, ...target },
    ]);
    const burst = 12;
    const results = await Promise.all(
      Array.from({ length: burst }, () => verify(artifactRef, target))
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
  const target = { graphWorkflowId: "graph:slot", graphTaskId: "node:slot" };
  const verify = createGitResultArtifactVerifier([
    { repositoryRoot, commit, path, artifactRef, ...target },
    {
      repositoryRoot,
      commit: "0".repeat(40),
      path,
      artifactRef: missingRef,
      ...target,
    },
  ]);
  // More failing git calls than there are slots; a leaked slot would leave
  // the final verification queued forever.
  expect(
    await Promise.all(
      Array.from({ length: 10 }, () => verify(missingRef, target))
    )
  ).toEqual(Array.from({ length: 10 }, () => false));
  const settled = await Promise.race([
    verify(artifactRef, target),
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("still-queued"), 5000)
    ),
  ]);
  expect(settled).toBe(true);
}, 15_000);
