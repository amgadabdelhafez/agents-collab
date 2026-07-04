import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentUsage } from "./types";

// USD per 1,000,000 tokens. Claude rates from the platform pricing table;
// cache-read ≈ 0.1x input, cache-write (5m TTL) ≈ 1.25x input.
interface Price {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

const PER_MTOK = 1_000_000;

const PRICING: Record<string, Price> = {
  "claude-opus-4-8": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-4-7": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-4-6": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-sonnet-4-6": { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 },
  "claude-haiku-4-5": { cacheRead: 0.1, cacheWrite: 1.25, input: 1, output: 5 },
  "claude-fable-5": { cacheRead: 1, cacheWrite: 12.5, input: 10, output: 50 },
  // ESTIMATE — verify against current OpenAI pricing for gpt-5.5.
  "gpt-5.5": { cacheRead: 0.125, cacheWrite: 1.25, input: 1.25, output: 10 },
};

const CONTEXT_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 1_000_000,
  "gpt-5.5": 400_000,
};

const DEFAULT_WINDOW = 200_000;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const emptyUsage = (): AgentUsage => ({
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  contextTokens: 0,
  contextWindow: DEFAULT_WINDOW,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const eachJsonLine = (text: string, fn: (obj: Record<string, unknown>) => void): void => {
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      fn(asRecord(JSON.parse(line)));
    } catch {
      // Skip malformed lines.
    }
  }
};

const trackTs = (
  rec: Record<string, unknown>,
  bounds: { first?: string; last?: string }
): void => {
  const ts = rec.timestamp;
  if (typeof ts === "string") {
    if (!bounds.first) {
      bounds.first = ts;
    }
    bounds.last = ts;
  }
};

// Claude session transcript: one JSON object per line; assistant messages carry
// message.usage (input/output/cache tokens) and message.model.
export const summarizeClaude = (text: string): AgentUsage => {
  const usage = emptyUsage();
  const bounds: { first?: string; last?: string } = {};
  eachJsonLine(text, (rec) => {
    trackTs(rec, bounds);
    const message = asRecord(rec.message);
    const u = asRecord(message.usage);
    if (Object.keys(u).length === 0) {
      return;
    }
    const input = num(u.input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);
    usage.inputTokens += input;
    usage.outputTokens += num(u.output_tokens);
    usage.cacheReadTokens += cacheRead;
    usage.cacheCreateTokens += cacheCreate;
    if (typeof message.model === "string") {
      usage.model = message.model;
    }
    // Current context ≈ the latest turn's total input context.
    usage.contextTokens = input + cacheRead + cacheCreate;
  });
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreateTokens;
  usage.firstTs = bounds.first;
  usage.lastTs = bounds.last;
  return usage;
};

interface CodexTokens {
  cached: number;
  input: number;
  output: number;
  total: number;
}

// Depth-first search for the innermost object carrying token counts.
const findTokens = (value: unknown): CodexTokens | undefined => {
  const rec = asRecord(value);
  if ("input_tokens" in rec || "total_tokens" in rec) {
    return {
      cached: num(rec.cached_input_tokens),
      input: num(rec.input_tokens),
      output: num(rec.output_tokens),
      total: num(rec.total_tokens),
    };
  }
  for (const child of Object.values(rec)) {
    if (typeof child === "object" && child !== null) {
      const found = findTokens(child);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};

const tokenMagnitude = (t: CodexTokens): number =>
  t.total || t.input + t.output;

// Codex rollout transcript: token-count events carry running (cumulative)
// totals. Take the record with the largest total to get the session total,
// robust to interleaved per-turn records. Codex does not cleanly expose the
// *current* context size (its counters are lifetime), so contextTokens is left
// at 0 (rendered as "—") rather than reporting a misleading cumulative number.
export const summarizeCodex = (text: string): AgentUsage => {
  const usage = emptyUsage();
  const bounds: { first?: string; last?: string } = {};
  let best: CodexTokens | undefined;
  eachJsonLine(text, (rec) => {
    trackTs(rec, bounds);
    if (typeof rec.model === "string") {
      usage.model = rec.model;
    }
    const tokens = findTokens(rec);
    if (tokens && (!best || tokenMagnitude(tokens) > tokenMagnitude(best))) {
      best = tokens;
    }
  });
  if (best) {
    usage.inputTokens = best.input;
    usage.outputTokens = best.output;
    usage.cacheReadTokens = best.cached;
    usage.totalTokens = best.total || best.input + best.output;
  }
  usage.model = usage.model ?? "gpt-5.5";
  usage.firstTs = bounds.first;
  usage.lastTs = bounds.last;
  return usage;
};

const priceKey = (model?: string): string | undefined => {
  if (!model) {
    return undefined;
  }
  if (PRICING[model]) {
    return model;
  }
  return Object.keys(PRICING).find((key) => model.startsWith(key));
};

// Fill contextWindow + costUsd from the pricing/window tables.
export const applyPricing = (usage: AgentUsage): AgentUsage => {
  const key = priceKey(usage.model);
  const price = key ? PRICING[key] : undefined;
  const window = key ? (CONTEXT_WINDOW[key] ?? DEFAULT_WINDOW) : DEFAULT_WINDOW;
  const costUsd = price
    ? (usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheCreateTokens * price.cacheWrite) /
      PER_MTOK
    : 0;
  return { ...usage, contextWindow: window, costUsd };
};

const findClaudeTranscript = (sessionRef: string): string | undefined => {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) {
    return undefined;
  }
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionRef}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

// sessions/YYYY/MM/DD/rollout-*<threadRef>*.jsonl — walk a bounded tree.
const walkForThread = (
  dir: string,
  threadRef: string,
  depth: number
): string | undefined => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry.includes(threadRef) && entry.endsWith(".jsonl")) {
      return full;
    }
    if (depth > 0 && statSync(full).isDirectory()) {
      const found = walkForThread(full, threadRef, depth - 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};

// loop-fork gives each run its own CODEX_HOME, so the transcript lives under
// <runDir>/codex-home/sessions before falling back to the user's global home.
const findCodexTranscript = (
  threadRef: string,
  codexHome?: string
): string | undefined => {
  const roots = [
    ...(codexHome ? [join(codexHome, "sessions")] : []),
    join(homedir(), ".codex", "sessions"),
  ];
  for (const root of roots) {
    if (existsSync(root)) {
      const found = walkForThread(root, threadRef, 4);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};

// Locate and parse an agent's session transcript into a priced usage snapshot.
// Best-effort: any failure (no transcript, unknown agent) yields empty usage.
export const readAgentUsage = (
  agent: Agent,
  sessionRef?: string,
  codexHome?: string
): AgentUsage => {
  if (!sessionRef) {
    return emptyUsage();
  }
  try {
    let path: string | undefined;
    if (agent === "claude") {
      path = findClaudeTranscript(sessionRef);
    } else if (agent === "codex") {
      path = findCodexTranscript(sessionRef, codexHome);
    }
    if (!path) {
      return emptyUsage();
    }
    const text = readFileSync(path, "utf8");
    const parsed = agent === "codex" ? summarizeCodex(text) : summarizeClaude(text);
    return applyPricing(parsed);
  } catch {
    return emptyUsage();
  }
};
