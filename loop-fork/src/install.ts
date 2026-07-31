import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const BIN_DIR = join(homedir(), ".local", "bin");
const IS_WINDOWS = process.platform === "win32";
const LOOP_BINARY_NAME = IS_WINDOWS ? "loop.exe" : "loop";
const CLAUDE_ALIAS_NAME = IS_WINDOWS ? "claude-loop.cmd" : "claude-loop";
const CODEX_ALIAS_NAME = IS_WINDOWS ? "codex-loop.cmd" : "codex-loop";
const CURSOR_ALIAS_NAME = IS_WINDOWS ? "cursor-loop.cmd" : "cursor-loop";
const GEMINI_ALIAS_NAME = IS_WINDOWS ? "gemini-loop.cmd" : "gemini-loop";
const CANDIDATE_BINARIES = IS_WINDOWS
  ? ["loop.exe", "loop"]
  : ["loop", "loop.exe"];
const TMUX_NOTE = "Note: tmux is not installed.";
const TMUX_DEFAULT_MODE_NOTE =
  "The default 'loop' command opens a paired tmux workspace and will fail until tmux is installed.";
const TMUX_MACOS_HINT = "brew install tmux";
const TMUX_LINUX_HINT = "your package manager (for example: apt install tmux)";
const TMUX_VERSION_TIMEOUT_MS = 2000;
const EXECUTABLE_MODE = 0o755;
const COPY_BUFFER_BYTES = 1024 * 1024;

type AtomicStage = (temporaryFile: FileHandle) => Promise<void>;

interface OpenSource {
  file: FileHandle;
  snapshot: BigIntStats;
}

const temporaryInstallPath = (target: string): string =>
  join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
  );

const atomicInstallRegularFile = async (
  target: string,
  stage: AtomicStage,
  platform: NodeJS.Platform = process.platform,
  temporaryPath = temporaryInstallPath(target)
): Promise<void> => {
  await mkdir(dirname(target), { recursive: true });
  if (dirname(temporaryPath) !== dirname(target)) {
    throw new Error("Installer temporary file must share the target directory");
  }
  let temporaryFile: FileHandle | undefined;
  let ownsTemporaryFile = false;

  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    ownsTemporaryFile = true;
    await stage(temporaryFile);
    if (platform !== "win32") {
      await temporaryFile.chmod(EXECUTABLE_MODE);
    }
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, target);
    ownsTemporaryFile = false;
  } finally {
    if (temporaryFile) {
      await temporaryFile.close().catch(() => undefined);
    }
    if (ownsTemporaryFile) {
      await rm(temporaryPath, { force: true });
    }
  }
};

const assertRegularSourceStats = (
  source: string,
  sourceStats: BigIntStats
): void => {
  if (sourceStats.isSymbolicLink() || !sourceStats.isFile()) {
    throw new Error(
      `Built binary must be a regular non-symlink file: ${source}`
    );
  }
};

const sameFileIdentity = (left: BigIntStats, right: BigIntStats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameFileSnapshot = (left: BigIntStats, right: BigIntStats): boolean =>
  sameFileIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const openRegularSource = async (source: string): Promise<OpenSource> => {
  const initialPathStats = await lstat(source, { bigint: true });
  assertRegularSourceStats(source, initialPathStats);
  const sourceFile = await open(source, "r");

  try {
    const sourceStats = await sourceFile.stat({ bigint: true });
    const currentPathStats = await lstat(source, { bigint: true });
    assertRegularSourceStats(source, sourceStats);
    assertRegularSourceStats(source, currentPathStats);
    if (
      !(
        sameFileSnapshot(initialPathStats, sourceStats) &&
        sameFileSnapshot(sourceStats, currentPathStats)
      )
    ) {
      throw new Error(`Built binary changed while opening: ${source}`);
    }
    return { file: sourceFile, snapshot: sourceStats };
  } catch (error) {
    await sourceFile.close().catch(() => undefined);
    throw error;
  }
};

const copySourceSnapshot = async (
  source: string,
  openedSource: OpenSource,
  targetFile: FileHandle
): Promise<void> => {
  if (openedSource.snapshot.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Built binary is too large to install safely: ${source}`);
  }
  const expectedBytes = Number(openedSource.snapshot.size);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;

  while (position < expectedBytes) {
    const requestedBytes = Math.min(
      buffer.byteLength,
      expectedBytes - position
    );
    const { bytesRead } = await openedSource.file.read(
      buffer,
      0,
      requestedBytes,
      position
    );
    if (bytesRead === 0) {
      throw new Error(`Built binary changed while copying: ${source}`);
    }

    let written = 0;
    while (written < bytesRead) {
      const result = await targetFile.write(
        buffer,
        written,
        bytesRead - written,
        position + written
      );
      if (result.bytesWritten === 0) {
        throw new Error(`Could not stage built binary: ${source}`);
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }

  const finalHandleStats = await openedSource.file.stat({ bigint: true });
  const finalPathStats = await lstat(source, { bigint: true });
  assertRegularSourceStats(source, finalPathStats);
  if (
    !(
      sameFileSnapshot(openedSource.snapshot, finalHandleStats) &&
      sameFileSnapshot(openedSource.snapshot, finalPathStats)
    )
  ) {
    throw new Error(`Built binary changed while copying: ${source}`);
  }
};

const installBuiltBinaryAt = async (
  source: string,
  target: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  const openedSource = await openRegularSource(source);
  let sourceFile: FileHandle | undefined = openedSource.file;

  try {
    await atomicInstallRegularFile(
      target,
      async (temporaryFile) => {
        await copySourceSnapshot(source, openedSource, temporaryFile);
        await sourceFile?.close();
        sourceFile = undefined;
      },
      platform
    );
  } finally {
    await sourceFile?.close().catch(() => undefined);
  }
};

const installAliasAt = async (
  target: string,
  content: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  await atomicInstallRegularFile(
    target,
    async (temporaryFile) => {
      await temporaryFile.writeFile(content, {
        encoding: "utf8",
      });
    },
    platform
  );
};

const tmuxInstallHint = (
  platform: NodeJS.Platform = process.platform
): string => {
  if (platform === "darwin") {
    return TMUX_MACOS_HINT;
  }
  if (platform === "linux") {
    return TMUX_LINUX_HINT;
  }
  return "install tmux";
};

const tmuxNudgeLines = (
  platform: NodeJS.Platform = process.platform
): string[] => [
  "",
  TMUX_NOTE,
  TMUX_DEFAULT_MODE_NOTE,
  `Install tmux with: ${tmuxInstallHint(platform)}`,
];

const hasTmuxInstalled = (run: typeof spawnSync = spawnSync): boolean => {
  const result = run("tmux", ["-V"], {
    killSignal: "SIGKILL",
    stdio: "ignore",
    timeout: TMUX_VERSION_TIMEOUT_MS,
  });
  return !result.error && result.status === 0;
};

const logMissingTmuxNudge = (): void => {
  if (IS_WINDOWS || hasTmuxInstalled()) {
    return;
  }
  for (const line of tmuxNudgeLines()) {
    console.log(line);
  }
};

const findBuiltBinary = async (): Promise<string> => {
  for (const name of CANDIDATE_BINARIES) {
    const candidate = resolve(process.cwd(), name);
    try {
      const candidateStats = await lstat(candidate);
      if (!candidateStats.isSymbolicLink() && candidateStats.isFile()) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Built binary not found. Run `bun run build` first.");
};

const installUnixAlias = async (
  name: string,
  onlyFlag: string
): Promise<void> => {
  const target = join(BIN_DIR, name);
  const content =
    "#!/bin/sh\n" +
    `exec "$(dirname "$0")/${LOOP_BINARY_NAME}" ${onlyFlag} "$@"\n`;
  await installAliasAt(target, content);
  console.log(`Installed ${name} -> ${target}`);
};

const installWindowsAlias = async (
  name: string,
  onlyFlag: string
): Promise<void> => {
  const target = join(BIN_DIR, name);
  const content = `@echo off\r\n"%~dp0${LOOP_BINARY_NAME}" ${onlyFlag} %*\r\n`;
  await installAliasAt(target, content);
  console.log(`Installed ${name} -> ${target}`);
};

const installAliases = async (): Promise<void> => {
  if (IS_WINDOWS) {
    await installWindowsAlias(CLAUDE_ALIAS_NAME, "--claude-only");
    await installWindowsAlias(CODEX_ALIAS_NAME, "--codex-only");
    await installWindowsAlias(CURSOR_ALIAS_NAME, "--cursor-only");
    await installWindowsAlias(GEMINI_ALIAS_NAME, "--gemini-only");
    return;
  }
  await installUnixAlias(CLAUDE_ALIAS_NAME, "--claude-only");
  await installUnixAlias(CODEX_ALIAS_NAME, "--codex-only");
  await installUnixAlias(CURSOR_ALIAS_NAME, "--cursor-only");
  await installUnixAlias(GEMINI_ALIAS_NAME, "--gemini-only");
};

const installBinary = async (): Promise<void> => {
  const source = await findBuiltBinary();
  const target = join(BIN_DIR, LOOP_BINARY_NAME);

  await mkdir(BIN_DIR, { recursive: true });
  await installBuiltBinaryAt(source, target);

  console.log(`Installed loop -> ${target}`);
  await installAliases();
  logMissingTmuxNudge();
};

export const installInternals = {
  atomicInstallRegularFile,
  hasTmuxInstalled,
  installAliasAt,
  installBuiltBinaryAt,
  tmuxInstallHint,
  tmuxNudgeLines,
};

const main = async (): Promise<void> => {
  await installBinary();
};

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[loop] install failed: ${message}`);
    process.exit(1);
  });
}
