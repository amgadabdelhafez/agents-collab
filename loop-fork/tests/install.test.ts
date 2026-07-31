import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { installInternals } from "../src/install";

const roots: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "loop-atomic-install-"));
  roots.push(root);
  return root;
};

const temporaryArtifactsFor = (target: string): string[] => {
  const prefix = `.${basename(target)}.`;
  return readdirSync(dirname(target)).filter(
    (name) => name.startsWith(prefix) && name.endsWith(".tmp")
  );
};

test("tmux install hint uses brew on macOS", () => {
  expect(installInternals.tmuxInstallHint("darwin")).toBe("brew install tmux");
});

test("tmux install hint stays generic on Linux", () => {
  expect(installInternals.tmuxInstallHint("linux")).toBe(
    "your package manager (for example: apt install tmux)"
  );
});

test("tmux nudge explains why bare loop fails without tmux", () => {
  expect(installInternals.tmuxNudgeLines("linux")).toEqual([
    "",
    "Note: tmux is not installed.",
    "The default 'loop' command opens a paired tmux workspace and will fail until tmux is installed.",
    "Install tmux with: your package manager (for example: apt install tmux)",
  ]);
});

test("tmux install probe is kill-on-timeout bounded", () => {
  let invocation:
    | {
        args?: readonly string[];
        command?: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  const run = ((
    command: string,
    args?: readonly string[],
    options?: Record<string, unknown>
  ) => {
    invocation = { args, command, options };
    return { error: undefined, status: 0 };
  }) as unknown as Parameters<typeof installInternals.hasTmuxInstalled>[0];

  expect(installInternals.hasTmuxInstalled(run)).toBe(true);
  expect(invocation).toEqual({
    args: ["-V"],
    command: "tmux",
    options: {
      killSignal: "SIGKILL",
      stdio: "ignore",
      timeout: 2000,
    },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("installs an immutable regular-file snapshot of the built binary", async () => {
  const root = makeRoot();
  const source = join(root, "source-loop");
  const target = join(root, "bin", "loop");
  writeFileSync(source, "candidate-v1");
  chmodSync(source, 0o755);

  await installInternals.installBuiltBinaryAt(source, target, "darwin");
  writeFileSync(source, "candidate-v2");

  const installedStats = lstatSync(target);
  expect(installedStats.isFile()).toBe(true);
  expect(installedStats.isSymbolicLink()).toBe(false);
  expect(installedStats.mode % 0o1000).toBe(0o755);
  expect(readFileSync(target, "utf8")).toBe("candidate-v1");
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("atomically replaces a prior symlink with a regular file", async () => {
  const root = makeRoot();
  const oldSource = join(root, "old-loop");
  const source = join(root, "source-loop");
  const target = join(root, "bin", "loop");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(oldSource, "old-live-bytes");
  writeFileSync(source, "new-live-bytes");
  symlinkSync(oldSource, target);

  await installInternals.installBuiltBinaryAt(source, target, "darwin");

  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("new-live-bytes");
  expect(readFileSync(oldSource, "utf8")).toBe("old-live-bytes");
});

test("failed staging preserves the live target and leaves no temp file", async () => {
  const root = makeRoot();
  const source = join(root, "missing-source");
  const target = join(root, "bin", "loop");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "known-good");

  await expect(
    installInternals.installBuiltBinaryAt(source, target, "darwin")
  ).rejects.toThrow();

  expect(readFileSync(target, "utf8")).toBe("known-good");
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("post-reservation stage failure preserves target and cleans owned temp", async () => {
  const root = makeRoot();
  const target = join(root, "bin", "loop");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "known-good");

  await expect(
    installInternals.atomicInstallRegularFile(
      target,
      async (temporaryFile) => {
        await temporaryFile.writeFile("partial-candidate");
        throw new Error("forced stage failure");
      },
      "darwin"
    )
  ).rejects.toThrow("forced stage failure");

  expect(readFileSync(target, "utf8")).toBe("known-good");
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("exclusive temp collision preserves foreign temp and never stages", async () => {
  const root = makeRoot();
  const target = join(root, "bin", "loop");
  const collidingTemporaryPath = join(dirname(target), ".loop.forced.tmp");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "known-good");
  writeFileSync(collidingTemporaryPath, "foreign-temp");
  let stageCalled = false;

  await expect(
    installInternals.atomicInstallRegularFile(
      target,
      () => {
        stageCalled = true;
        return Promise.resolve();
      },
      "darwin",
      collidingTemporaryPath
    )
  ).rejects.toThrow();

  expect(stageCalled).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("known-good");
  expect(readFileSync(collidingTemporaryPath, "utf8")).toBe("foreign-temp");
});

test("failed publication cleans its fully staged temporary file", async () => {
  const root = makeRoot();
  const source = join(root, "source-loop");
  const target = join(root, "bin", "loop");
  writeFileSync(source, "candidate");
  mkdirSync(target, { recursive: true });

  await expect(
    installInternals.installBuiltBinaryAt(source, target, "darwin")
  ).rejects.toThrow();

  expect(lstatSync(target).isDirectory()).toBe(true);
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("rejects symbolic-link built binaries without changing the target", async () => {
  const root = makeRoot();
  const realSource = join(root, "real-source");
  const source = join(root, "linked-source");
  const target = join(root, "bin", "loop");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(realSource, "candidate");
  symlinkSync(realSource, source);
  writeFileSync(target, "known-good");

  await expect(
    installInternals.installBuiltBinaryAt(source, target, "darwin")
  ).rejects.toThrow("regular non-symlink");

  expect(readFileSync(target, "utf8")).toBe("known-good");
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("source path swap cannot install symlink-target bytes", async () => {
  const root = makeRoot();
  const source = join(root, "source-loop");
  const originalSource = join(root, "source-loop-original");
  const payload = join(root, "payload");
  const target = join(root, "bin", "loop");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(source, "checked-source");
  writeFileSync(payload, "symlink-payload");
  writeFileSync(target, "known-good");

  const installation = installInternals.installBuiltBinaryAt(
    source,
    target,
    "darwin"
  );
  renameSync(source, originalSource);
  symlinkSync(payload, source);

  await expect(installation).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("known-good");
  expect(readFileSync(target, "utf8")).not.toBe("symlink-payload");
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("concurrent readers observe only complete old or new snapshots", async () => {
  const root = makeRoot();
  const source = join(root, "source-loop");
  const target = join(root, "bin", "loop");
  const oldBytes = "old";
  const newBytes = "new".repeat(2_000_000);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(source, newBytes);
  writeFileSync(target, oldBytes);

  const replacement = installInternals.installBuiltBinaryAt(
    source,
    target,
    "darwin"
  );
  const observed = await Promise.all(
    Array.from({ length: 20 }, async () => readFile(target, "utf8"))
  );
  await replacement;

  for (const snapshot of observed) {
    expect([oldBytes, newBytes]).toContain(snapshot);
  }
  expect(readFileSync(target, "utf8")).toBe(newBytes);
});

test("simultaneous writers publish one complete snapshot without temp leaks", async () => {
  const root = makeRoot();
  const sourceA = join(root, "source-a");
  const sourceB = join(root, "source-b");
  const target = join(root, "bin", "loop");
  const bytesA = "alpha".repeat(200_000);
  const bytesB = "bravo".repeat(200_000);
  writeFileSync(sourceA, bytesA);
  writeFileSync(sourceB, bytesB);

  await Promise.all([
    installInternals.installBuiltBinaryAt(sourceA, target, "darwin"),
    installInternals.installBuiltBinaryAt(sourceB, target, "darwin"),
  ]);

  expect([bytesA, bytesB]).toContain(readFileSync(target, "utf8"));
  expect(lstatSync(target).isSymbolicLink()).toBe(false);
  expect(temporaryArtifactsFor(target)).toEqual([]);
});

test("installs Unix and Windows aliases through regular-file replacement", async () => {
  const root = makeRoot();
  const unixTarget = join(root, "bin", "claude-loop");
  const windowsTarget = join(root, "bin", "codex-loop.cmd");
  const unixContent =
    '#!/bin/sh\nexec "$(dirname "$0")/loop" --claude-only "$@"\n';
  const windowsContent = '@echo off\r\n"%~dp0loop.exe" --codex-only %*\r\n';

  await installInternals.installAliasAt(unixTarget, unixContent, "darwin");
  await installInternals.installAliasAt(windowsTarget, windowsContent, "win32");

  expect(lstatSync(unixTarget).isSymbolicLink()).toBe(false);
  expect(lstatSync(unixTarget).mode % 0o1000).toBe(0o755);
  expect(readFileSync(unixTarget, "utf8")).toBe(unixContent);
  expect(lstatSync(windowsTarget).isSymbolicLink()).toBe(false);
  expect(readFileSync(windowsTarget, "utf8")).toBe(windowsContent);
  expect(temporaryArtifactsFor(unixTarget)).toEqual([]);
  expect(temporaryArtifactsFor(windowsTarget)).toEqual([]);
});
