import { expect, test } from "bun:test";
import { partialUsdCell } from "../../src/loop/governess";
import {
  readUtilityObservability,
  type UtilityTranscriptEntry,
} from "../../src/loop/utility-observability";
import { renderUtilityTranscript } from "../../src/loop/utility-runtime";

test("partial price preserves its unknown marker across large amounts", () => {
  for (const amount of [0.003, 9999.49, 9999.5, 10_000, 1e12]) {
    const cell = partialUsdCell(amount);
    expect(cell.length).toBeLessThanOrEqual(7);
    expect(cell.endsWith("+?")).toBe(true);
  }
});

test("pane retains newest completed outcome over shorter older job", () => {
  const transcript: UtilityTranscriptEntry[] = [
    {
      at: "2026-10-05T01:00:00Z",
      jobId: "old",
      kind: "response",
      label: "OLD CONTEXT",
      text: "Old short result",
    },
    {
      at: "2026-10-05T02:00:00Z",
      jobId: "new",
      kind: "request",
      label: "CLAUDE→QWEN",
      text: "Inspect the current guard",
    },
    ...Array.from(
      { length: 10 },
      (_, i): UtilityTranscriptEntry => ({
        at: `2026-10-05T02:00:${String(i + 1).padStart(2, "0")}Z`,
        jobId: "new",
        kind: "tool",
        label: "QWEN",
        text: "read_file ok",
      })
    ),
    {
      at: "2026-10-05T02:01:00Z",
      jobId: "new",
      kind: "response",
      label: "QWEN OK",
      text: "New bounded evidence ".repeat(30),
      usage: {
        cachedInputTokens: 10,
        costSource: "local-zero-rate",
        costUsd: 0,
        durationMs: 100,
        inputTokens: 20,
        outputTokens: 5,
        modelCalls: 5,
        toolCalls: 4,
        totalTokens: 25,
      },
    },
  ];
  const text = renderUtilityTranscript(
    { ...readUtilityObservability(), transcript },
    68,
    9
  ).join("\n");
  expect(text).toContain("QWEN OK");
  expect(text).toContain("5 calls");
  expect(text).not.toContain("OLD CONTEXT");
});
