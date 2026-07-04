import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { spawn } from "bun";
import type { Options } from "../../src/loop/types";

type ClaudeSdkModule = typeof import("../../src/loop/claude-sdk-server");

// Other test files (e.g., runner.test.ts) call `mock.module(...)` on
// claude-sdk-server and Bun does not auto-restore module mocks across files.
// Append a unique query suffix so this test always loads a fresh, unmocked copy.
const sdkServerImportPath = `${resolve(process.cwd(), "src/loop/claude-sdk-server.ts")}?sdk-stdio-test`;

let claudeSdkInternals: ClaudeSdkModule["claudeSdkInternals"];
let closeClaudeSdk: ClaudeSdkModule["closeClaudeSdk"];
let runClaudeTurn: ClaudeSdkModule["runClaudeTurn"];
let startClaudeSdk: ClaudeSdkModule["startClaudeSdk"];

const makeOptions = (): Options => ({
  agent: "claude",
  doneSignal: "<done/>",
  format: "raw",
  maxIterations: 1,
  codexModel: "test-model",
  proof: "proof",
});

interface FakeChild {
  exited: Promise<number>;
  kill: () => void;
  pid: number;
  stderr: ReadableStream<Uint8Array>;
  stdin: { end: () => void; flush: () => void; write: (chunk: string) => void };
  stdout: ReadableStream<Uint8Array>;
}

interface FakeChildHandle {
  child: FakeChild;
  emit: (line: string) => void;
  endStdout: () => void;
  exit: (code: number) => void;
  stdinWrites: string[];
}

const createFakeChild = (pid: number): FakeChildHandle => {
  const stdinWrites: string[] = [];
  const encoder = new TextEncoder();

  let emitChunk: ((chunk: Uint8Array) => void) | undefined;
  let closeStdout: (() => void) | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      emitChunk = (chunk) => controller.enqueue(chunk);
      closeStdout = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  let exitCode: number | undefined;
  const exit = (code: number): void => {
    if (exitCode !== undefined) {
      return;
    }
    exitCode = code;
    closeStdout?.();
    resolveExit?.(code);
  };

  const child: FakeChild = {
    exited,
    kill: () => exit(0),
    pid,
    stderr,
    stdin: {
      end: () => {
        // ignore end requests in test
      },
      flush: () => {
        // ignore flush in test
      },
      write: (chunk: string) => {
        stdinWrites.push(chunk);
      },
    },
    stdout,
  };

  return {
    child,
    emit: (line: string) => {
      emitChunk?.(encoder.encode(line));
    },
    endStdout: () => closeStdout?.(),
    exit,
    stdinWrites,
  };
};

let fakeHandle: FakeChildHandle | undefined;
let lastSpawnCommand: string[] = [];

beforeEach(async () => {
  const module = (await import(sdkServerImportPath)) as ClaudeSdkModule;
  claudeSdkInternals = module.claudeSdkInternals;
  closeClaudeSdk = module.closeClaudeSdk;
  runClaudeTurn = module.runClaudeTurn;
  startClaudeSdk = module.startClaudeSdk;
  claudeSdkInternals.setChildPollIntervalMs(5);
  claudeSdkInternals.setWaitTimeoutMs(2000);

  claudeSdkInternals.setSpawnFn(((args: string[]) => {
    lastSpawnCommand = args;
    fakeHandle = createFakeChild(50_000);
    return fakeHandle.child;
  }) as unknown as (
    ...args: Parameters<typeof spawn>
  ) => ReturnType<typeof spawn>);
});

afterEach(async () => {
  if (fakeHandle) {
    fakeHandle.exit(0);
  }
  await closeClaudeSdk();
  fakeHandle = undefined;
  lastSpawnCommand = [];
  claudeSdkInternals.restoreSpawnFn();
  claudeSdkInternals.restoreChildPollIntervalMs();
  claudeSdkInternals.restoreWaitTimeoutMs();
});

const startAndWaitForReady = async (): Promise<void> => {
  await startClaudeSdk("test-model");
};

test("spawns claude in stdio stream-json mode without --sdk-url", async () => {
  await startAndWaitForReady();

  expect(lastSpawnCommand[0]).toBe("claude");
  expect(lastSpawnCommand).toContain("--input-format");
  expect(lastSpawnCommand).toContain("stream-json");
  expect(lastSpawnCommand).toContain("--output-format");
  expect(lastSpawnCommand).toContain("--dangerously-skip-permissions");
  expect(lastSpawnCommand).not.toContain("--sdk-url");
});

test("runTurn writes user message to stdin and resolves on result", async () => {
  await startAndWaitForReady();
  const handle = fakeHandle;
  if (!handle) {
    throw new Error("fakeHandle missing");
  }

  const turnPromise = runClaudeTurn("hello", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  await new Promise((r) => setTimeout(r, 5));
  expect(handle.stdinWrites.length).toBeGreaterThan(0);
  const sent = JSON.parse(handle.stdinWrites[0].trim()) as {
    message: { content: string; role: string };
    type: string;
  };
  expect(sent.type).toBe("user");
  expect(sent.message.role).toBe("user");
  expect(sent.message.content).toBe("hello");

  handle.emit(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-abc",
    })}\n`
  );
  handle.emit(
    `${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })}\n`
  );
  handle.emit(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
    })}\n`
  );

  const result = await turnPromise;
  expect(result.exitCode).toBe(0);
  expect(result.parsed).toBe("hi");
});

test("runTurn rejects when claude exits before result", async () => {
  await startAndWaitForReady();
  const handle = fakeHandle;
  if (!handle) {
    throw new Error("fakeHandle missing");
  }

  const turnPromise = runClaudeTurn("hello", makeOptions(), {
    onDelta: () => undefined,
    onParsed: () => undefined,
    onRaw: () => undefined,
  });

  await new Promise((r) => setTimeout(r, 5));
  handle.exit(1);

  await expect(turnPromise).rejects.toThrow();
});
