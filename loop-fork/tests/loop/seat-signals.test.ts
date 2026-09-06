import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tableContextWindow } from "../../src/loop/governess-usage";
import type { RunManifest } from "../../src/loop/run-state";
import {
  catalogContextWindow,
  collectSeatSignals,
  DEFAULT_CONTEXT_WINDOW,
  readOpenCodeSessionSignals,
  readRoutingLog,
  readSeatSignals,
  resolveContextWindow,
  seatSignalsParity,
  totalCostFromStats,
} from "../../src/loop/seat-signals";
import type { AgentUsage } from "../../src/loop/types";

const usage = (overrides: Partial<AgentUsage> = {}): AgentUsage => ({
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  compactedContextTokens: 0,
  compactions: 0,
  contextRateTokensPerMinute: 0,
  contextTokens: 0,
  contextWindow: 0,
  costRateUsdPerHour: 0,
  costUsd: 0,
  dataConfidence: "exact",
  humanMessages: 0,
  inputTokens: 0,
  messages: 0,
  outputTokens: 0,
  textMessages: 0,
  thinkingMessages: 0,
  toolCallCounts: {},
  ...overrides,
});

const manifest = (overrides: Partial<RunManifest> = {}): RunManifest =>
  ({
    claudeSessionId: "",
    codexThreadId: "",
    ossSessionId: "",
    ...overrides,
  }) as RunManifest;

describe("context window resolution", () => {
  test("the seat's own report beats the catalog, the catalog beats the table, the table beats the default", () => {
    const lookup = (model: string) => (model === "m" ? 400_000 : undefined);
    expect(resolveContextWindow("m", 272_000, lookup)).toMatchObject({
      chosen: 272_000,
      source: "transcript",
    });
    expect(resolveContextWindow("m", undefined, lookup)).toMatchObject({
      chosen: 400_000,
      source: "catalog",
    });
    expect(
      resolveContextWindow("gpt-5.5", undefined, () => undefined)
    ).toMatchObject({
      chosen: tableContextWindow("gpt-5.5"),
      source: "table",
    });
    expect(
      resolveContextWindow("unknown-model", undefined, () => undefined)
    ).toMatchObject({
      chosen: DEFAULT_CONTEXT_WINDOW,
      source: "default",
    });
    // A transcript that only echoes the default is not a report.
    expect(
      resolveContextWindow("m", DEFAULT_CONTEXT_WINDOW, lookup).source
    ).toBe("catalog");
  });

  test("pi-ai's built-in catalog answers for the seats we run (H7's missing source)", () => {
    expect(catalogContextWindow("claude-fable-5")).toBe(1_000_000);
    expect(catalogContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(catalogContextWindow("claude-opus-4-6-20260101")).toBe(1_000_000);
    expect(catalogContextWindow("z-ai/glm-5.2")).toBeGreaterThan(0);
    expect(catalogContextWindow("no-such-model-xyz")).toBeUndefined();
  });

  test("the loop's table and the catalog disagree on gpt-5.5, and the resolution says which it used", () => {
    const resolved = resolveContextWindow("gpt-5.5", undefined);
    expect(resolved.table).toBe(1_050_000);
    expect(resolved.catalog).toBe(272_000);
    expect(resolved.source).toBe("catalog");
  });
});

describe("routing log", () => {
  test("sums Switchyard rows per task, model and tier", () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-signals-"));
    const log = join(dir, "routing.jsonl");
    const row = (
      task: string,
      model: string,
      tier: string,
      prompt: number,
      completion: number,
      ts: string
    ) =>
      JSON.stringify({
        algorithm: "stage_router",
        cache_creation_tokens: 0,
        cached_tokens: 10,
        completion_tokens: completion,
        model,
        prompt_tokens: prompt,
        reasoning_tokens: 0,
        route_id: "au-pair",
        session_id: `s-${task}`,
        task,
        tier,
        total_tokens: prompt + completion,
        ts,
      });
    writeFileSync(
      log,
      [
        row(
          "t1",
          "z-ai/glm-5.2",
          "capable",
          1000,
          100,
          "2026-09-06T10:00:00.000Z"
        ),
        row(
          "t1",
          "local/qwen",
          "efficient",
          500,
          50,
          "2026-09-06T10:01:00.000Z"
        ),
        row(
          "t2",
          "z-ai/glm-5.2",
          "capable",
          9999,
          999,
          "2026-09-06T10:02:00.000Z"
        ),
        "not json",
      ].join("\n")
    );
    const t1 = readRoutingLog(log, { task: "t1" });
    expect(t1?.rows).toBe(2);
    expect(t1?.total.promptTokens).toBe(1500);
    expect(t1?.byTier.capable?.completionTokens).toBe(100);
    expect(t1?.byModel["local/qwen"]?.requests).toBe(1);
    expect(t1?.lastTs).toBe("2026-09-06T10:01:00.000Z");
    expect(
      readRoutingLog(log, { task: "t1", sinceTs: "2026-09-06T10:00:30.000Z" })
        ?.rows
    ).toBe(1);
    expect(readRoutingLog(join(dir, "missing.jsonl"))).toBeUndefined();
  });
});

describe("OpenCode session signals", () => {
  test("reads context tokens, cost and compactions from the sqlite message rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-signals-oc-"));
    const dbPath = join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)"
    );
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const assistant = (
      id: string,
      t: number,
      input: number,
      read: number,
      write: number,
      cost: number
    ) =>
      insert.run(
        id,
        "ses_x",
        t,
        t,
        JSON.stringify({
          cost,
          modelID: "z-ai/glm-5.2",
          role: "assistant",
          tokens: { cache: { read, write }, input, output: 20, reasoning: 0 },
        })
      );
    insert.run("m0", "ses_x", 1, 1, JSON.stringify({ role: "user" }));
    assistant("m1", 2, 1000, 0, 500, 0.01);
    assistant("m2", 3, 1200, 1500, 100, 0.02);
    assistant("m3", 4, 300, 200, 0, 0.005); // context collapsed: a compaction
    insert.run(
      "m9",
      "ses_other",
      5,
      5,
      JSON.stringify({
        cost: 9,
        modelID: "other",
        role: "assistant",
        tokens: { input: 1, output: 1 },
      })
    );
    db.close();
    const s = readOpenCodeSessionSignals(dbPath, "ses_x");
    expect(s.found).toBe(true);
    expect(s.contextTokens).toBe(500);
    expect(s.compactions).toBe(1);
    expect(s.messages).toBe(4);
    expect(s.costUsd).toBeCloseTo(0.035, 6);
    expect(s.model).toBe("z-ai/glm-5.2");
    expect(readOpenCodeSessionSignals(dbPath, "ses_none").found).toBe(false);
    expect(
      readOpenCodeSessionSignals(join(dir, "nope.db"), "ses_x").found
    ).toBe(false);
  });
});

describe("seat signals and parity", () => {
  test("a seat with no session reports source none and no numbers", () => {
    const s = readSeatSignals("claude", manifest(), {
      readUsage: () => usage(),
    });
    expect(s.source).toBe("none");
    expect(s.contextTokens).toBeUndefined();
    expect(s.window).toBeUndefined();
    expect(s.costSource).toBe("none");
  });

  test("a claude seat's transcript feeds the signals; the rate table is parity only", () => {
    const s = readSeatSignals(
      "claude",
      manifest({ claudeSessionId: "sess-1" }),
      {
        readUsage: () =>
          usage({
            compactions: 2,
            contextTokens: 350_000,
            contextWindow: 0,
            inputTokens: 10,
            messages: 40,
            model: "claude-fable-5",
          }),
        windowLookup: () => 1_000_000,
      }
    );
    expect(s.source).toBe("transcript");
    expect(s.contextTokens).toBe(350_000);
    expect(s.window).toMatchObject({ chosen: 1_000_000, source: "catalog" });
    expect(s.costSource).toBe("none");
    expect(typeof s.tableCostUsd).toBe("number");
    const parity = seatSignalsParity(
      s,
      usage({ contextTokens: 340_000, contextWindow: 200_000 })
    );
    expect(parity).toMatchObject({
      contextTokens: 350_000,
      governessContextTokens: 340_000,
      governessWindow: 200_000,
      windowAgrees: false,
    });
  });

  test("a missing transcript is reported as none, never as zero context", () => {
    const s = readSeatSignals("codex", manifest({ codexThreadId: "thr" }), {
      readUsage: () => usage({ dataConfidence: "missing" }),
    });
    expect(s.source).toBe("none");
    expect(s.contextTokens).toBeUndefined();
  });

  test("collectSeatSignals returns one row per agent and attaches the routing log", () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-signals-c-"));
    const log = join(dir, "routing.jsonl");
    writeFileSync(
      log,
      `${JSON.stringify({ model: "m", prompt_tokens: 7, session_id: "sess-1", task: "task-a", tier: "efficient", total_tokens: 7, ts: "2026-09-06T10:00:00.000Z" })}\n`
    );
    const rows = collectSeatSignals(
      ["claude", "oss"],
      manifest({ claudeSessionId: "sess-1" }),
      {
        openCodeDbPath: join(dir, "absent.db"),
        readUsage: () => usage({ contextTokens: 1, model: "claude-fable-5" }),
        routingLogPath: log,
        task: "task-a",
      }
    );
    expect(rows.map((r) => r.agent)).toEqual(["claude", "oss"]);
    expect(rows[0]?.routed?.total.promptTokens).toBe(7);
    expect(rows[1]?.source).toBe("none");
  });

  test("stats cost is summed from cost fields at any depth", () => {
    expect(
      totalCostFromStats({
        models: [{ cost_usd: 1.5 }, { nested: { cost: 0.25 } }],
        other: "x",
      })
    ).toBeCloseTo(1.75, 6);
  });
});
