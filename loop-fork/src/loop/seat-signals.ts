// Seat signals: what a seat can report about itself, read from the seat's own
// records instead of scraped from a tmux pane.
//
// gov-1 of the Governess rewrite. Observe mode only: nothing here changes a
// control decision. Each tick the Governess appends one `seat-signals` row per
// agent to governess.jsonl beside its own estimate, so the parity between the
// pane-derived numbers and the seat-derived numbers is measurable before any
// switch (gov-2 moves session pressure onto these numbers once the rows agree).
//
// Sources, in the order a value is trusted:
//   context window  transcript-reported (Codex model_context_window) >
//                   pi-ai built-in model catalog > the loop's table > default
//   context tokens  the seat's own transcript (Claude Code JSONL, Codex
//                   rollout, OpenCode sqlite message rows)
//   routed tokens   the Switchyard routing log (per task / session / tier)
//   cost            Switchyard /v1/stats when reachable (provider-reported);
//                   the loop's rate table is reported as `tableCostUsd` only
// A seat with no readable source reports source "none" and no numbers; a
// guessed number is worse than an absent one.

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModels as getCatalogModels } from "@earendil-works/pi-ai/compat";
import {
  applyPricing,
  readAgentUsage,
  tableContextWindow,
} from "./governess-usage";
import type { RunManifest } from "./run-state";
import type { Agent, AgentUsage } from "./types";

export const DEFAULT_CONTEXT_WINDOW = 200_000;
const TRAILING_SLASH_RE = /\/$/;
export const SEAT_SIGNALS_KIND = "seat-signals";

export type WindowSource = "transcript" | "catalog" | "table" | "default";
export type SignalSource = "transcript" | "opencode-db" | "none";
export type CostSource = "switchyard-stats" | "none";

export interface ContextWindowResolution {
  catalog?: number;
  chosen: number;
  source: WindowSource;
  table?: number;
  transcript?: number;
}

export interface RoutedTokens {
  cacheCreationTokens: number;
  cachedTokens: number;
  completionTokens: number;
  promptTokens: number;
  reasoningTokens: number;
  requests: number;
  totalTokens: number;
}

export interface RoutingLogSummary {
  byModel: Record<string, RoutedTokens>;
  byTier: Record<string, RoutedTokens>;
  lastTs?: string;
  rows: number;
  total: RoutedTokens;
}

export interface SeatSignals {
  agent: Agent;
  compactions?: number;
  contextTokens?: number;
  costSource: CostSource;
  costUsd?: number;
  messages?: number;
  model?: string;
  routed?: RoutingLogSummary;
  sessionRef?: string;
  source: SignalSource;
  // The loop's own rate-table estimate, kept for parity, never as cost.
  tableCostUsd?: number;
  window?: ContextWindowResolution;
}

export interface SeatSignalsParity {
  agent: Agent;
  contextTokens?: number;
  governessContextTokens?: number;
  governessWindow?: number;
  window?: ContextWindowResolution;
  windowAgrees?: boolean;
}

type CatalogLookup = (model: string) => number | undefined;

const CATALOG_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

let catalogCache: Map<string, number> | undefined;

// pi-ai ships a built-in model catalog with context windows; the loop already
// depends on pi-ai, so this is a data source we own no copy of.
const loadCatalog = (): Map<string, number> => {
  if (catalogCache) {
    return catalogCache;
  }
  const map = new Map<string, number>();
  for (const provider of CATALOG_PROVIDERS) {
    let models: readonly { contextWindow?: number; id: string }[] = [];
    try {
      models = getCatalogModels(provider) ?? [];
    } catch {
      // A provider whose catalog throws yields nothing; the resolver says so.
    }
    for (const model of models) {
      if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
        map.set(model.id, model.contextWindow);
        // OpenRouter ids carry a vendor prefix; index the bare id too.
        const bare = model.id.includes("/")
          ? model.id.slice(model.id.indexOf("/") + 1)
          : model.id;
        if (!map.has(bare)) {
          map.set(bare, model.contextWindow);
        }
      }
    }
  }
  catalogCache = map;
  return map;
};

export const catalogContextWindow: CatalogLookup = (model) => {
  const catalog = loadCatalog();
  const normalized = model.trim();
  if (catalog.has(normalized)) {
    return catalog.get(normalized);
  }
  // Date-suffixed or dotted variants: claude-opus-4-6-20260101, claude-opus-4.6
  const dashed = normalized.replace(/\./g, "-");
  if (catalog.has(dashed)) {
    return catalog.get(dashed);
  }
  const prefix = [...catalog.keys()].find(
    (id) => normalized.startsWith(`${id}-`) || dashed.startsWith(`${id}-`)
  );
  return prefix ? catalog.get(prefix) : undefined;
};

export const resolveContextWindow = (
  model: string | undefined,
  transcriptWindow: number | undefined,
  lookup: CatalogLookup = catalogContextWindow
): ContextWindowResolution => {
  const transcript =
    transcriptWindow &&
    transcriptWindow > 0 &&
    transcriptWindow !== DEFAULT_CONTEXT_WINDOW
      ? transcriptWindow
      : undefined;
  const catalog = model ? lookup(model) : undefined;
  const table = model ? tableContextWindow(model) : undefined;
  if (transcript) {
    return {
      catalog,
      chosen: transcript,
      source: "transcript",
      table,
      transcript,
    };
  }
  if (catalog) {
    return { catalog, chosen: catalog, source: "catalog", table };
  }
  if (table) {
    return { catalog, chosen: table, source: "table", table };
  }
  return { catalog, chosen: DEFAULT_CONTEXT_WINDOW, source: "default", table };
};

const zeroRouted = (): RoutedTokens => ({
  cacheCreationTokens: 0,
  cachedTokens: 0,
  completionTokens: 0,
  promptTokens: 0,
  reasoningTokens: 0,
  requests: 0,
  totalTokens: 0,
});

const addRouted = (into: RoutedTokens, row: Record<string, unknown>): void => {
  const n = (key: string): number => {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  into.requests += 1;
  into.promptTokens += n("prompt_tokens");
  into.cachedTokens += n("cached_tokens");
  into.cacheCreationTokens += n("cache_creation_tokens");
  into.completionTokens += n("completion_tokens");
  into.reasoningTokens += n("reasoning_tokens");
  into.totalTokens += n("total_tokens");
};

interface RoutingFilter {
  sessionId?: string;
  sinceTs?: string;
  task?: string;
}

const parseRoutingRow = (
  line: string,
  filter: RoutingFilter
): Record<string, unknown> | undefined => {
  if (!line.trim()) {
    return undefined;
  }
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (filter.task && row.task !== filter.task) {
    return undefined;
  }
  if (filter.sessionId && row.session_id !== filter.sessionId) {
    return undefined;
  }
  const ts = typeof row.ts === "string" ? row.ts : "";
  if (filter.sinceTs && ts && ts <= filter.sinceTs) {
    return undefined;
  }
  return row;
};

// Switchyard's routing log: one JSON row per request with task, session_id,
// model, tier and token counts (no USD; that lives on /v1/stats).
export const readRoutingLog = (
  path: string,
  filter: RoutingFilter = {}
): RoutingLogSummary | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const summary: RoutingLogSummary = {
    byModel: {},
    byTier: {},
    rows: 0,
    total: zeroRouted(),
  };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const row = parseRoutingRow(line, filter);
    if (!row) {
      continue;
    }
    const ts = typeof row.ts === "string" ? row.ts : "";
    summary.rows += 1;
    summary.lastTs = ts || summary.lastTs;
    addRouted(summary.total, row);
    const model = typeof row.model === "string" ? row.model : "unknown";
    const tier =
      typeof row.tier === "string" && row.tier ? row.tier : "untiered";
    summary.byModel[model] ??= zeroRouted();
    summary.byTier[tier] ??= zeroRouted();
    addRouted(summary.byModel[model], row);
    addRouted(summary.byTier[tier], row);
  }
  return summary;
};

export const defaultOpenCodeDbPath = (home = homedir()): string =>
  join(home, ".local", "share", "opencode", "opencode.db");

interface OpenCodeMessageData {
  cost?: number;
  modelID?: string;
  role?: string;
  tokens?: {
    cache?: { read?: number; write?: number };
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

interface OpenCodeFold {
  compactions: number;
  contextTokens: number;
  costUsd: number;
  messages: number;
  model?: string;
}

const foldOpenCodeMessage = (acc: OpenCodeFold, data: string): void => {
  let parsed: OpenCodeMessageData;
  try {
    parsed = JSON.parse(data) as OpenCodeMessageData;
  } catch {
    return;
  }
  acc.messages += 1;
  if (parsed.role !== "assistant") {
    return;
  }
  if (typeof parsed.cost === "number") {
    acc.costUsd += parsed.cost;
  }
  if (parsed.modelID) {
    acc.model = parsed.modelID;
  }
  const t = parsed.tokens;
  if (!t) {
    return;
  }
  const context = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
  if (context > 0) {
    // The context halving in one step is a compaction, not a short turn.
    if (acc.contextTokens > 0 && context < acc.contextTokens / 2) {
      acc.compactions += 1;
    }
    acc.contextTokens = context;
  }
};

// OpenCode 1.4 keeps sessions in sqlite: message.data is the JSON the server
// wrote, with per-message tokens and provider-reported cost. The last
// assistant message's input + cache read + cache write is the context the
// seat is carrying now.
export const readOpenCodeSessionSignals = (
  dbPath: string,
  sessionId: string
): Pick<SeatSignals, "compactions" | "contextTokens" | "messages" | "model"> & {
  costUsd: number;
  found: boolean;
} => {
  const empty = { costUsd: 0, found: false };
  if (!existsSync(dbPath)) {
    return empty;
  }
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC"
      )
      .all(sessionId) as { data: string }[];
    if (rows.length === 0) {
      return empty;
    }
    const acc: OpenCodeFold = {
      compactions: 0,
      contextTokens: 0,
      costUsd: 0,
      messages: 0,
    };
    for (const { data } of rows) {
      foldOpenCodeMessage(acc, data);
    }
    return { ...acc, found: true };
  } catch {
    return empty;
  } finally {
    db?.close();
  }
};

export interface SwitchyardStatsCost {
  costUsd?: number;
  reachable: boolean;
}

// /v1/stats reports provider-derived cost per model; only source of USD here.
export const readSwitchyardStatsCost = async (
  url: string | undefined,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 2000
): Promise<SwitchyardStatsCost> => {
  if (!url) {
    return { reachable: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(
      `${url.replace(TRAILING_SLASH_RE, "")}/v1/stats`,
      {
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      return { reachable: false };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    return { costUsd: totalCostFromStats(payload), reachable: true };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
};

// The stats shape is theirs and pre-1.0; sum every numeric field named
// cost_usd or cost at any depth rather than binding to one layout.
export const totalCostFromStats = (payload: unknown): number => {
  let total = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>
      )) {
        if (
          (key === "cost_usd" || key === "cost") &&
          typeof item === "number"
        ) {
          total += item;
        } else {
          walk(item);
        }
      }
    }
  };
  walk(payload);
  return total;
};

export interface SeatSignalInputs {
  codexHome?: string;
  openCodeDbPath?: string;
  readUsage?: (
    agent: Agent,
    sessionRef?: string,
    codexHome?: string
  ) => AgentUsage;
  routingLogPath?: string;
  routingLogSinceTs?: string;
  task?: string;
  windowLookup?: CatalogLookup;
}

const sessionRefFor = (
  agent: Agent,
  manifest: RunManifest | undefined
): string | undefined => {
  if (!manifest) {
    return undefined;
  }
  if (agent === "claude") {
    return manifest.claudeSessionId || undefined;
  }
  if (agent === "codex") {
    return manifest.codexThreadId || undefined;
  }
  return manifest.ossSessionId || undefined;
};

export const readSeatSignals = (
  agent: Agent,
  manifest: RunManifest | undefined,
  inputs: SeatSignalInputs = {}
): SeatSignals => {
  const sessionRef = sessionRefFor(agent, manifest);
  const readUsage = inputs.readUsage ?? readAgentUsage;
  const base: SeatSignals = {
    agent,
    costSource: "none",
    sessionRef,
    source: "none",
  };
  const routed = inputs.routingLogPath
    ? readRoutingLog(inputs.routingLogPath, {
        sessionId: inputs.task ? undefined : sessionRef,
        sinceTs: inputs.routingLogSinceTs,
        task: inputs.task,
      })
    : undefined;
  if (routed) {
    base.routed = routed;
  }
  if (!sessionRef) {
    return base;
  }
  if (agent === "oss") {
    const oc = readOpenCodeSessionSignals(
      inputs.openCodeDbPath ?? defaultOpenCodeDbPath(),
      sessionRef
    );
    if (!oc.found) {
      return base;
    }
    return {
      ...base,
      compactions: oc.compactions,
      contextTokens: oc.contextTokens,
      messages: oc.messages,
      model: oc.model,
      source: "opencode-db",
      // OpenCode's per-message cost is provider-reported, not a table.
      ...(oc.costUsd > 0
        ? { costSource: "switchyard-stats" as const, costUsd: oc.costUsd }
        : {}),
      window: resolveContextWindow(oc.model, undefined, inputs.windowLookup),
    };
  }
  const usage = readUsage(agent, sessionRef, inputs.codexHome);
  if (usage.dataConfidence === "missing" || usage.dataConfidence === "error") {
    return base;
  }
  const priced = applyPricing(usage);
  return {
    ...base,
    compactions: usage.compactions,
    contextTokens: usage.contextTokens,
    messages: usage.messages,
    model: usage.model,
    source: "transcript",
    tableCostUsd: priced.costUsd,
    window: resolveContextWindow(
      usage.model,
      usage.contextWindow,
      inputs.windowLookup
    ),
  };
};

// One parity row: the seat's numbers next to what the Governess believed.
export const seatSignalsParity = (
  signals: SeatSignals,
  governessUsage: AgentUsage | undefined
): SeatSignalsParity => {
  const row: SeatSignalsParity = { agent: signals.agent };
  if (signals.contextTokens !== undefined) {
    row.contextTokens = signals.contextTokens;
  }
  if (signals.window) {
    row.window = signals.window;
  }
  if (governessUsage) {
    row.governessContextTokens = governessUsage.contextTokens;
    row.governessWindow = governessUsage.contextWindow;
    if (signals.window) {
      row.windowAgrees = signals.window.chosen === governessUsage.contextWindow;
    }
  }
  return row;
};

// Manifest-free entry for the Governess tick, which already knows each seat's
// session ref and Codex home.
export const readSeatSignalsForRef = (
  agent: Agent,
  sessionRef: string | undefined,
  codexHome: string | undefined,
  inputs: SeatSignalInputs = {}
): SeatSignals => {
  const manifest = {
    claudeSessionId: agent === "claude" ? (sessionRef ?? "") : "",
    codexThreadId: agent === "codex" ? (sessionRef ?? "") : "",
    ossSessionId: agent === "oss" ? (sessionRef ?? "") : "",
  } as RunManifest;
  return readSeatSignals(agent, manifest, { ...inputs, codexHome });
};

export const collectSeatSignals = (
  agents: Agent[],
  manifest: RunManifest | undefined,
  inputs: SeatSignalInputs = {}
): SeatSignals[] =>
  agents.map((agent) => readSeatSignals(agent, manifest, inputs));
