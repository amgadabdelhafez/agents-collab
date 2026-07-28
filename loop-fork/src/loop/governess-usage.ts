import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentUsage, UsageDataConfidence } from "./types";

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
  "claude-sonnet-4-6": {
    cacheRead: 0.3,
    cacheWrite: 3.75,
    input: 3,
    output: 15,
  },
  "claude-haiku-4-5": { cacheRead: 0.1, cacheWrite: 1.25, input: 1, output: 5 },
  "claude-fable-5": { cacheRead: 1, cacheWrite: 12.5, input: 10, output: 50 },
  // OpenAI gpt-5.5: $5 input / $0.50 cached / $30 output per 1M tokens.
  "gpt-5.5": { cacheRead: 0.5, cacheWrite: 5, input: 5, output: 30 },
};

const CONTEXT_WINDOW: Record<string, number> = {
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5": 200_000,
  "claude-fable-5": 1_000_000,
  "gpt-5.5": 1_050_000,
};

const DEFAULT_WINDOW = 200_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MAX_CONTEXT_SAMPLES = 12;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const CODEX_FAST_CREDIT_MULTIPLIER: [string, number][] = [
  ["gpt-5.5", 2.5],
  ["gpt-5.4", 2],
];

const codexFastCreditMultiplier = (model?: string): number | undefined => {
  if (!model) {
    return undefined;
  }
  return CODEX_FAST_CREDIT_MULTIPLIER.find(([prefix]) =>
    model.startsWith(prefix)
  )?.[1];
};

const setCreditMultiplier = (usage: AgentUsage): void => {
  const speed = usage.speed?.toLowerCase();
  const tier = usage.serviceTier?.toLowerCase();
  if (speed === "fast" || tier === "fast" || tier === "priority") {
    usage.creditCostMultiplier = codexFastCreditMultiplier(usage.model);
  } else if (speed || tier) {
    usage.creditCostMultiplier = 1;
  }
};

const emptyUsage = (
  dataConfidence: UsageDataConfidence = "missing"
): AgentUsage => ({
  cacheCreate1hTokens: 0,
  cacheCreateTokens: 0,
  cacheReadTokens: 0,
  compactedContextTokens: 0,
  compactions: 0,
  contextTokens: 0,
  contextRateTokensPerMinute: 0,
  contextWindow: DEFAULT_WINDOW,
  costRateUsdPerHour: 0,
  costUsd: 0,
  dataConfidence,
  humanMessages: 0,
  inputTokens: 0,
  messages: 0,
  outputTokens: 0,
  textMessages: 0,
  thinkingMessages: 0,
  toolCalls: 0,
  toolCallCounts: {},
  totalTokens: 0,
});

interface ContextSample {
  tokens: number;
  tsMs: number;
}

const toolName = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const incrementToolCall = (usage: AgentUsage, name: string): void => {
  usage.toolCalls += 1;
  usage.toolCallCounts[name] = (usage.toolCallCounts[name] ?? 0) + 1;
};

const countClaudeAssistantBlocks = (
  usage: AgentUsage,
  content: unknown
): void => {
  if (typeof content === "string") {
    if (content.trim()) {
      usage.textMessages += 1;
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    const rec = asRecord(block);
    const type = rec.type;
    if (type === "text") {
      usage.textMessages += 1;
    } else if (type === "thinking") {
      usage.thinkingMessages += 1;
    } else if (type === "tool_use") {
      incrementToolCall(usage, toolName(rec.name, "tool_use"));
    }
  }
};

const codexToolName = (payload: Record<string, unknown>): string => {
  const name = toolName(payload.name, "");
  if (name) {
    return name;
  }
  if (payload.type === "tool_search_call") {
    return "tool_search";
  }
  if (payload.type === "custom_tool_call") {
    return "custom_tool";
  }
  return "function_call";
};

const countCodexResponseItem = (
  usage: AgentUsage,
  payload: Record<string, unknown>
): void => {
  const type = payload.type;
  if (type === "reasoning") {
    usage.thinkingMessages += 1;
  } else if (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "tool_search_call"
  ) {
    incrementToolCall(usage, codexToolName(payload));
  } else if (type === "message" && payload.role === "assistant") {
    usage.textMessages += 1;
  }
};

const isBillableModel = (model: string | undefined): model is string =>
  Boolean(model) && !model.startsWith("<");

const eachJsonLine = (
  text: string,
  fn: (obj: Record<string, unknown>) => void
): void => {
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

const recordContextSample = (
  samples: ContextSample[],
  ts: unknown,
  tokens: number
): void => {
  if (typeof ts !== "string" || tokens <= 0) {
    return;
  }
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs)) {
    return;
  }
  samples.push({ tokens, tsMs });
  if (samples.length > MAX_CONTEXT_SAMPLES) {
    samples.shift();
  }
};

const applyContextRate = (
  usage: AgentUsage,
  samples: ContextSample[]
): void => {
  if (samples.length < 2) {
    return;
  }
  const first = samples[0];
  const last = samples.at(-1);
  if (!last || last.tsMs <= first.tsMs || last.tokens <= first.tokens) {
    return;
  }
  usage.contextRateTokensPerMinute =
    ((last.tokens - first.tokens) / (last.tsMs - first.tsMs)) * MS_PER_MINUTE;
};

const compactPreTokens = (
  rec: Record<string, unknown>,
  fallback = 0
): number => {
  const meta = asRecord(rec.compactMetadata);
  const payload = asRecord(rec.payload);
  return (
    num(meta.preTokens) ||
    num(meta.pre_tokens) ||
    num(payload.preTokens) ||
    num(payload.pre_tokens) ||
    fallback
  );
};

const setRateLimits = (usage: AgentUsage, rec: Record<string, unknown>): void => {
  const payload = asRecord(rec.payload);
  const rateLimits = asRecord(rec.rate_limits ?? payload.rate_limits);
  const primary = asRecord(rateLimits.primary);
  const secondary = asRecord(rateLimits.secondary);
  const primaryPct = num(primary.used_percent);
  const secondaryPct = num(secondary.used_percent);
  if (primaryPct > 0) {
    usage.rateLimitPrimaryPct = primaryPct;
  }
  if (secondaryPct > 0) {
    usage.rateLimitSecondaryPct = secondaryPct;
  }
};

const applyCostRate = (usage: AgentUsage): void => {
  if (!usage.firstTs || !usage.lastTs || usage.costUsd <= 0) {
    return;
  }
  const first = Date.parse(usage.firstTs);
  const last = Date.parse(usage.lastTs);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) {
    return;
  }
  usage.costRateUsdPerHour = usage.costUsd / ((last - first) / MS_PER_HOUR);
};

const claudeAssistantKey = (
  rec: Record<string, unknown>,
  message: Record<string, unknown>
): string | undefined => {
  const requestId = str(rec.requestId);
  if (requestId) {
    return `request:${requestId}`;
  }
  const messageId = str(message.id);
  return messageId ? `message:${messageId}` : undefined;
};

// Claude session transcript: one JSON object per line; assistant messages carry
// message.usage (input/output/cache tokens) and message.model.
export const summarizeClaude = (text: string): AgentUsage => {
  const usage = emptyUsage("exact");
  const bounds: { first?: string; last?: string } = {};
  const contextSamples: ContextSample[] = [];
  const seenAssistantMessages = new Set<string>();
  const seenUsageRecords = new Set<string>();
  eachJsonLine(text, (rec) => {
    trackTs(rec, bounds);
    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      usage.compactions += 1;
      usage.compactedContextTokens += compactPreTokens(rec);
      usage.lastCompactionTs =
        typeof rec.timestamp === "string" ? rec.timestamp : usage.lastCompactionTs;
      contextSamples.length = 0;
    }
    const message = asRecord(rec.message);
    const role = typeof rec.type === "string" ? rec.type : message.role;
    const meta = rec.isMeta === true || rec.isSidechain === true;
    if (role === "assistant") {
      const key = claudeAssistantKey(rec, message);
      if (!key || !seenAssistantMessages.has(key)) {
        usage.messages += 1;
      }
      countClaudeAssistantBlocks(usage, message.content);
      if (key) {
        seenAssistantMessages.add(key);
      }
    } else if (role === "user" && !meta && cleanHumanFromContent(message.content)) {
      usage.humanMessages += 1;
    }
    const u = asRecord(message.usage);
    if (Object.keys(u).length === 0) {
      return;
    }
    const input = num(u.input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheCreate = num(u.cache_creation_input_tokens);
    const cacheCreate1h = num(
      asRecord(u.cache_creation).ephemeral_1h_input_tokens
    );
    const output = num(u.output_tokens);
    const tokenTotal = input + cacheRead + cacheCreate + output;
    if (tokenTotal === 0) {
      return;
    }
    const usageKey = claudeAssistantKey(rec, message);
    if (usageKey) {
      if (seenUsageRecords.has(usageKey)) {
        return;
      }
      seenUsageRecords.add(usageKey);
    }
    usage.inputTokens += input;
    usage.outputTokens += output;
    usage.cacheReadTokens += cacheRead;
    usage.cacheCreateTokens += cacheCreate;
    usage.cacheCreate1hTokens =
      (usage.cacheCreate1hTokens ?? 0) + Math.min(cacheCreate, cacheCreate1h);
    usage.serviceTier = str(u.service_tier) ?? usage.serviceTier;
    usage.speed = str(u.speed) ?? usage.speed;
    if (usage.serviceTier === "standard" || usage.speed === "standard") {
      usage.creditCostMultiplier = 1;
    }
    const model = typeof message.model === "string" ? message.model : undefined;
    if (isBillableModel(model)) {
      usage.model = model;
    }
    // Current context ≈ the latest turn's total input context.
    usage.contextTokens = input + cacheRead + cacheCreate;
    recordContextSample(contextSamples, rec.timestamp, usage.contextTokens);
  });
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreateTokens;
  usage.firstTs = bounds.first;
  usage.lastTs = bounds.last;
  applyContextRate(usage, contextSamples);
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

const uncachedCodexInput = (t: CodexTokens): number =>
  Math.max(0, t.input - t.cached);

interface CodexInfoTokens {
  context: number;
  contextWindow: number;
  cumulative: CodexTokens;
}

// Codex logs `payload.info.total_token_usage` (cumulative) and
// `last_token_usage` (the most recent turn, whose input_tokens ≈ the current
// context window fill). Extract both when present.
const findInfoTokens = (
  rec: Record<string, unknown>
): CodexInfoTokens | undefined => {
  const payload = asRecord(rec.payload);
  const info = asRecord(payload.info);
  const total = asRecord(info.total_token_usage);
  if (!("total_tokens" in total || "input_tokens" in total)) {
    return undefined;
  }
  const last = asRecord(info.last_token_usage);
  return {
    context: num(last.input_tokens),
    contextWindow:
      num(info.model_context_window) || num(payload.model_context_window),
    cumulative: {
      cached: num(total.cached_input_tokens),
      input: num(total.input_tokens),
      output: num(total.output_tokens),
      total: num(total.total_tokens),
    },
  };
};

// Find a message role in a codex rollout entry (role may be nested in payload).
const findRole = (rec: Record<string, unknown>): string | undefined => {
  if (typeof rec.role === "string") {
    return rec.role;
  }
  const payload = asRecord(rec.payload);
  if (typeof payload.role === "string" && payload.type === "message") {
    return payload.role;
  }
  return undefined;
};

// Codex rollout transcript: token-count events carry running (cumulative)
// totals. Take the record with the largest total to get the session total,
// robust to interleaved per-turn records. last_token_usage.input_tokens is the
// latest turn's context fill; model_context_window may arrive on token-count
// or task-start events, so remember the latest nonzero value independently.
export const summarizeCodex = (text: string): AgentUsage => {
  const usage = emptyUsage("exact");
  const bounds: { first?: string; last?: string } = {};
  const contextSamples: ContextSample[] = [];
  let bestInfo: CodexInfoTokens | undefined;
  let bestGeneric: CodexTokens | undefined;
  let latestContext = 0;
  let transcriptContextWindow = 0;
  eachJsonLine(text, (rec) => {
    trackTs(rec, bounds);
    setRateLimits(usage, rec);
    const payload = asRecord(rec.payload);
    if (rec.type === "response_item") {
      countCodexResponseItem(usage, payload);
    }
    if (typeof rec.model === "string") {
      usage.model = rec.model;
    }
    if (typeof payload.model === "string") {
      usage.model = payload.model;
    }
    usage.reasoningEffort =
      str(payload.effort) ??
      str(payload.reasoning_effort) ??
      str(payload.model_reasoning_effort) ??
      usage.reasoningEffort;
    usage.serviceTier =
      str(payload.service_tier) ?? str(payload.serviceTier) ?? usage.serviceTier;
    usage.speed = str(payload.speed) ?? usage.speed;
    const payloadContextWindow = num(payload.model_context_window);
    if (payloadContextWindow > 0) {
      transcriptContextWindow = payloadContextWindow;
    }
    const role = findRole(rec);
    if (role === "assistant") {
      usage.messages += 1;
    } else if (role === "user" && cleanHumanFromContent(payload.content ?? rec.content)) {
      usage.humanMessages += 1;
    }
    const info = findInfoTokens(rec);
    if (info) {
      if (info.context > 0) {
        latestContext = info.context;
        recordContextSample(contextSamples, rec.timestamp, info.context);
      }
      if (info.contextWindow > 0) {
        transcriptContextWindow = info.contextWindow;
      }
      if (!bestInfo || info.cumulative.total > bestInfo.cumulative.total) {
        bestInfo = info;
      }
      return;
    }
    if (rec.type === "compacted") {
      usage.compactions += 1;
      usage.compactedContextTokens += compactPreTokens(rec, latestContext);
      usage.dataConfidence = "approx";
      usage.lastCompactionTs =
        typeof rec.timestamp === "string" ? rec.timestamp : usage.lastCompactionTs;
      contextSamples.length = 0;
      return;
    }
    const tokens = findTokens(rec);
    if (
      tokens &&
      (!bestGeneric || tokenMagnitude(tokens) > tokenMagnitude(bestGeneric))
    ) {
      bestGeneric = tokens;
    }
  });
  if (bestInfo) {
    const c = bestInfo.cumulative;
    usage.inputTokens = uncachedCodexInput(c);
    usage.outputTokens = c.output;
    usage.cacheReadTokens = c.cached;
    usage.totalTokens = c.total || c.input + c.output;
    usage.contextTokens = bestInfo.context;
  } else if (bestGeneric) {
    usage.inputTokens = uncachedCodexInput(bestGeneric);
    usage.outputTokens = bestGeneric.output;
    usage.cacheReadTokens = bestGeneric.cached;
    usage.totalTokens =
      bestGeneric.total || bestGeneric.input + bestGeneric.output;
  }
  if (transcriptContextWindow > 0) {
    usage.contextWindow = transcriptContextWindow;
  }
  usage.model = usage.model ?? "gpt-5.5";
  setCreditMultiplier(usage);
  usage.firstTs = bounds.first;
  usage.lastTs = bounds.last;
  applyContextRate(usage, contextSamples);
  return usage;
};

const applyCodexHistoryMode = (
  usage: AgentUsage,
  sessionRef: string,
  codexHome?: string
): void => {
  const roots = [
    ...(codexHome ? [codexHome] : []),
    join(homedir(), ".codex"),
  ];
  let mode: "fast" | "standard" | undefined;
  for (const root of roots) {
    const path = join(root, "history.jsonl");
    if (!existsSync(path)) {
      continue;
    }
    eachJsonLine(readFileSync(path, "utf8"), (rec) => {
      if (rec.session_id !== sessionRef) {
        return;
      }
      const text = str(rec.text)?.toLowerCase();
      if (text === "/fast on") {
        mode = "fast";
      } else if (text === "/fast off") {
        mode = "standard";
      }
    });
  }
  if (!mode) {
    return;
  }
  usage.speed = mode;
  usage.serviceTier = mode;
  setCreditMultiplier(usage);
};

const readTomlString = (text: string, key: string): string | undefined => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, "m")
  );
  return match?.[1]?.trim() || undefined;
};

const applyCodexConfigMode = (usage: AgentUsage, codexHome?: string): void => {
  if (!codexHome || usage.speed || usage.serviceTier) {
    return;
  }
  const path = join(codexHome, "config.toml");
  if (!existsSync(path)) {
    return;
  }
  const tier = readTomlString(readFileSync(path, "utf8"), "service_tier");
  if (!tier) {
    return;
  }
  usage.serviceTier = tier;
  setCreditMultiplier(usage);
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
  const tableWindow = key
    ? (CONTEXT_WINDOW[key] ?? DEFAULT_WINDOW)
    : DEFAULT_WINDOW;
  const window =
    usage.contextWindow > 0 && usage.contextWindow !== DEFAULT_WINDOW
      ? usage.contextWindow
      : tableWindow;
  const costUsd = price
    ? (usage.inputTokens * price.input +
        usage.outputTokens * price.output +
        usage.cacheReadTokens * price.cacheRead +
        usage.cacheCreateTokens * price.cacheWrite) /
      PER_MTOK
    : 0;
  const priced = { ...usage, contextWindow: window, costUsd };
  applyCostRate(priced);
  return priced;
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

const MAX_HUMAN_MESSAGES = 16;
const MAX_HUMAN_MESSAGE_CHARS = 260;
const WHITESPACE_RE = /\s+/g;
const BRIDGE_DELIVERY_PREFIX_RE =
  /^(claude|codex|copilot|cursor|gemini)\s*:/i;
const INJECTED_TASK_SECTION_RE =
  /(?:^|\n)\s*Task:\s*(?:\n\s*)?(?:#{1,6}\s*)?([^\n]+)/i;
// User turns that are actually harness/tooling injections, not real requests.
const INJECTED_MARKERS = [
  "Base directory for this skill",
  "system-reminder",
  "<command-",
  "<subagent_notification>",
  "tool_use_error",
];
const INJECTED_PREFIXES = [
  "# AGENTS.md instructions",
  "Agent-to-agent pair programming:",
  "[bridge ",
  "/compact governess:",
  "governess:",
  "[Request interrupted by user",
];

const textFromContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const text = asRecord(block).text;
        return typeof text === "string" ? text : "";
      })
      .join(" ");
  }
  return "";
};

const cleanHuman = (raw: string): string | undefined => {
  if (raw.trimStart().startsWith("Agent-to-agent pair programming:")) {
    const task = INJECTED_TASK_SECTION_RE.exec(raw)?.[1]
      ?.replace(WHITESPACE_RE, " ")
      .trim();
    if (task) {
      const objective = `Task: ${task}`;
      return objective.length > MAX_HUMAN_MESSAGE_CHARS
        ? `${objective.slice(0, MAX_HUMAN_MESSAGE_CHARS)}…`
        : objective;
    }
  }
  const text = raw.replace(WHITESPACE_RE, " ").trim();
  if (
    !text ||
    text.startsWith("<") ||
    BRIDGE_DELIVERY_PREFIX_RE.test(text) ||
    INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
    INJECTED_MARKERS.some((marker) => text.includes(marker))
  ) {
    return undefined;
  }
  return text.length > MAX_HUMAN_MESSAGE_CHARS
    ? `${text.slice(0, MAX_HUMAN_MESSAGE_CHARS)}…`
    : text;
};

const cleanHumanFromContent = (content: unknown): string | undefined =>
  cleanHuman(textFromContent(content));

const claudeHumanMessages = (text: string): string[] => {
  const out: string[] = [];
  eachJsonLine(text, (rec) => {
    const message = asRecord(rec.message);
    const role = typeof rec.type === "string" ? rec.type : message.role;
    const meta = rec.isMeta === true || rec.isSidechain === true;
    if (role !== "user" || meta) {
      return;
    }
    const cleaned = cleanHumanFromContent(message.content);
    if (cleaned) {
      out.push(cleaned);
    }
  });
  return out;
};

const codexHumanMessages = (text: string): string[] => {
  const out: string[] = [];
  eachJsonLine(text, (rec) => {
    if (findRole(rec) !== "user") {
      return;
    }
    const payload = asRecord(rec.payload);
    const cleaned = cleanHumanFromContent(payload.content ?? rec.content);
    if (cleaned) {
      out.push(cleaned);
    }
  });
  return out;
};

// Extract the verbatim human instructions from an agent's transcript (most
// recent last), so the summary knows what the session was actually asked to do.
export const readHumanMessages = (
  agent: Agent,
  sessionRef?: string,
  codexHome?: string
): string[] => {
  if (!sessionRef) {
    return [];
  }
  try {
    const path =
      agent === "claude"
        ? findClaudeTranscript(sessionRef)
        : findCodexTranscript(sessionRef, codexHome);
    if (!path) {
      return [];
    }
    const text = readFileSync(path, "utf8");
    const all =
      agent === "codex" ? codexHumanMessages(text) : claudeHumanMessages(text);
    return all.slice(-MAX_HUMAN_MESSAGES);
  } catch {
    return [];
  }
};

// Locate and parse an agent's session transcript into a priced usage snapshot.
// Best-effort: any failure (no transcript, unknown agent) yields empty usage.
export const readAgentUsage = (
  agent: Agent,
  sessionRef?: string,
  codexHome?: string
): AgentUsage => {
  if (!sessionRef) {
    return emptyUsage("missing");
  }
  try {
    let path: string | undefined;
    if (agent === "claude") {
      path = findClaudeTranscript(sessionRef);
    } else if (agent === "codex") {
      path = findCodexTranscript(sessionRef, codexHome);
    }
    if (!path) {
      return emptyUsage("missing");
    }
    const text = readFileSync(path, "utf8");
    const parsed =
      agent === "codex" ? summarizeCodex(text) : summarizeClaude(text);
    if (agent === "codex") {
      applyCodexConfigMode(parsed, codexHome);
      applyCodexHistoryMode(parsed, sessionRef, codexHome);
    }
    return applyPricing(parsed);
  } catch {
    return emptyUsage("error");
  }
};
