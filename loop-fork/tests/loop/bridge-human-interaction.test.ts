import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runBridge = async (
  runDir: string,
  source: "claude" | "supervisor",
  request: unknown
): Promise<Record<string, unknown>> => {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "src", "cli.ts"), "__bridge-mcp", runDir, source],
    { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
  );
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
};

const makeRun = (): { root: string; runDir: string } => {
  const root = mkdtempSync(join(tmpdir(), "bridge-public-ask-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "manifest.json"),
    JSON.stringify({
      createdAt: "2026-08-28T11:00:00.000Z",
      cwd: "/worktree",
      mode: "paired",
      pid: 42,
      repoId: "repo-a",
      runId: "7",
      state: "input-required",
      status: "running",
      updatedAt: "2026-08-28T11:59:59.000Z",
    })
  );
  writeFileSync(
    join(runDir, "governess-state.json"),
    JSON.stringify({
      lifecycleEvents: {
        claude: {
          agent: "claude",
          at: "2026-08-28T11:59:58.000Z",
          epoch: 3,
          sequence: 12,
          state: "input-required",
        },
      },
    })
  );
  return { root, runDir };
};

test("agent bridge publishes a bounded ask without caller authority fields", async () => {
  const { root, runDir } = makeRun();
  try {
    const response = await runBridge(runDir, "claude", {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          kind: "question",
          prompt: "Which migration window should I use?",
          title: "Migration window",
        },
        name: "publish_human_ask",
      },
    });
    expect(response).toHaveProperty("result");
    const journal = readFileSync(
      join(runDir, "public-human-asks.jsonl"),
      "utf8"
    );
    expect(journal).toContain('"agent":"claude"');
    expect(journal).not.toContain("provider");
    expect(journal).not.toContain("routeId");

    const rejected = await runBridge(runDir, "supervisor", {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          kind: "question",
          prompt: "Expose a private value?",
          title: "Foreign ask",
        },
        name: "publish_human_ask",
      },
    });
    expect(rejected).toMatchObject({
      error: { message: expect.stringContaining("agent-scoped bridge source") },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal manifest with stale agent state neither advertises nor publishes", async () => {
  const { root, runDir } = makeRun();
  try {
    writeFileSync(
      join(runDir, "manifest.json"),
      JSON.stringify({
        createdAt: "2026-08-28T11:00:00.000Z",
        cwd: "/worktree",
        mode: "paired",
        pid: 42,
        repoId: "repo-a",
        runId: "7",
        state: "completed",
        status: "done",
        updatedAt: "2026-08-28T12:00:00.000Z",
      })
    );
    const listed = await runBridge(runDir, "claude", {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    const tools = (
      listed.result as { tools?: Record<string, unknown>[] } | undefined
    )?.tools;
    expect(tools?.map((tool) => tool.name)).not.toContain("publish_human_ask");

    const rejected = await runBridge(runDir, "claude", {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          kind: "question",
          prompt: "Which migration window should I use?",
          title: "Migration window",
        },
        name: "publish_human_ask",
      },
    });
    expect(rejected).toHaveProperty("error");
    expect(() =>
      readFileSync(join(runDir, "public-human-asks.jsonl"))
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge advertises the producer tool for an active run and rejects caller authority", async () => {
  const { root, runDir } = makeRun();
  try {
    const listed = await runBridge(runDir, "claude", {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    const tools = (
      listed.result as { tools?: Record<string, unknown>[] } | undefined
    )?.tools;
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "publish_human_ask" }),
      ])
    );

    const rejected = await runBridge(runDir, "claude", {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          agent: "codex",
          kind: "question",
          prompt: "Which migration window should I use?",
          title: "Migration window",
        },
        name: "publish_human_ask",
      },
    });
    expect(rejected).toMatchObject({
      error: { message: "publish_human_ask input is invalid" },
    });
    expect(() =>
      readFileSync(join(runDir, "public-human-asks.jsonl"))
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active run lists the ask tool while the agent is working, and a mid-turn ask binds to the next episode", async () => {
  const { root, runDir } = makeRun();
  try {
    writeFileSync(
      join(runDir, "governess-state.json"),
      JSON.stringify({
        lifecycleEvents: {
          claude: {
            agent: "claude",
            at: "2026-08-28T11:59:58.000Z",
            epoch: 3,
            sequence: 13,
            state: "working",
          },
        },
      })
    );
    const listed = await runBridge(runDir, "claude", {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/list",
    });
    const names = (
      (listed.result as { tools?: { name: string }[] } | undefined)?.tools ?? []
    ).map((tool) => tool.name);
    // Agents list tools once at session start, while working.
    expect(names).toContain("publish_human_ask");

    const refused = await runBridge(runDir, "claude", {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          kind: "question",
          prompt: "Which migration window should I use?",
          title: "Migration window",
        },
        name: "publish_human_ask",
      },
    });
    expect(refused).toHaveProperty("result");
    const journal = readFileSync(
      join(runDir, "public-human-asks.jsonl"),
      "utf8"
    );
    expect(journal).toContain('"sequence":14');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
