import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortModel } from "../../src/loop/governess";
import {
  catalogContextWindow,
  resolveContextWindow,
} from "../../src/loop/model-catalog";
import { readOpenCodeSessionSignals } from "../../src/loop/seat-signals";

describe("the pane names the model, not the vendor", () => {
  test("a provider-qualified id shortens to the model, not to its prefix", () => {
    // Before: "openrouter/z-ai/glm-5.2" sliced to 12 chars gave "openrouter/z".
    expect(shortModel("openrouter/z-ai/glm-5.2")).toBe("glm-5.2");
    expect(shortModel("z-ai/glm-5.2")).toBe("glm-5.2");
    expect(shortModel("claude-opus-5")).toBe("opus-5");
    expect(shortModel("anthropic/claude-opus-5")).toBe("opus-5");
    expect(shortModel(undefined)).toBe("—");
  });

  test("the shortened name never exceeds the column", () => {
    expect(
      shortModel("openrouter/some-vendor/an-extremely-long-model-name").length
    ).toBeLessThanOrEqual(12);
  });
});

describe("the catalog answers for a provider-qualified seat", () => {
  test("a routed seat's window comes from the catalog, not the 200k default", () => {
    const qualified = resolveContextWindow(
      "openrouter/z-ai/glm-5.2",
      undefined
    );
    const bare = resolveContextWindow("z-ai/glm-5.2", undefined);
    expect(qualified.source).toBe("catalog");
    expect(qualified.chosen).toBe(bare.chosen);
    expect(qualified.chosen).toBeGreaterThan(200_000);
    expect(catalogContextWindow("anthropic/claude-opus-5")).toBe(
      catalogContextWindow("claude-opus-5")
    );
  });

  test("an unknown model still falls to the default rather than a wrong number", () => {
    const unknown = resolveContextWindow(
      "openrouter/nobody/no-such-model-xyz",
      undefined
    );
    expect(unknown.source).toBe("default");
    expect(unknown.chosen).toBe(200_000);
  });
});

describe("the OSS seat's token breakdown reaches the pane", () => {
  const seed = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "seat-pane-oc-"));
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
      output: number,
      reasoning: number
    ) =>
      insert.run(
        id,
        "ses_x",
        t,
        t,
        JSON.stringify({
          cost: 0.01,
          modelID: "z-ai/glm-5.2",
          providerID: "openrouter",
          role: "assistant",
          tokens: { cache: { read, write }, input, output, reasoning },
        })
      );
    assistant("m1", 1, 100, 10, 5, 20, 3);
    assistant("m2", 2, 200, 30, 7, 40, 6);
    db.close();
    return dbPath;
  };

  test("input, output and cache totals are summed across the session", () => {
    const s = readOpenCodeSessionSignals(seed(), "ses_x");
    expect(s.found).toBe(true);
    expect(s.inputTokens).toBe(300);
    expect(s.outputTokens).toBe(60);
    expect(s.reasoningTokens).toBe(9);
    expect(s.cacheReadTokens).toBe(40);
    expect(s.cacheCreateTokens).toBe(12);
  });

  test("context stays the last message's carried tokens, not the running total", () => {
    const s = readOpenCodeSessionSignals(seed(), "ses_x");
    // Last message only: 200 input + 30 cache read + 7 cache write.
    expect(s.contextTokens).toBe(237);
    expect(s.contextTokens).not.toBe(s.inputTokens);
  });

  test("a session that does not exist reports nothing rather than zeros", () => {
    const s = readOpenCodeSessionSignals(seed(), "ses_missing");
    expect(s.found).toBe(false);
  });
});
