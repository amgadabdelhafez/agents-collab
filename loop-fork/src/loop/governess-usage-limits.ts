import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentUsage,
  UsageLimitKind,
  UsageLimitWindow,
} from "./types";

export interface AgentUsageLimit {
  primaryPct?: number;
  primaryReset?: string;
  secondaryPct?: number;
  secondaryReset?: string;
  windows?: UsageLimitWindow[];
}

interface TokenRates {
  cacheRead: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  input: number;
  output: number;
}

interface UsageTrackerPricingRate {
  basis: "api_usd_per_mtok" | "credits_per_mtok";
  effectiveFromMs?: number;
  effectiveUntilMs?: number;
  modelPrefix: string;
  provider: "claude" | "codex";
  rates?: TokenRates;
  unpricedReason?: string;
}

export interface UsageTrackerPricing {
  codexCreditUsd: number;
  rates: UsageTrackerPricingRate[];
  source: string;
}

export interface UsageLimitSnapshot
  extends Partial<Record<Agent, AgentUsageLimit>> {
  pricing?: UsageTrackerPricing;
}

export interface UsageTrackerLimitConfig {
  configPath?: string;
  pricingCatalogPath?: string;
  secret?: string;
  timeoutMs?: number;
  url?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 1500;
const PER_MTOK = 1_000_000;
const NUMERIC_RE = /^\d+(?:\.\d+)?$/;
const CONFIG_SECRET_RE =
  /^\s*(?:export\s+)?USAGE_TRACKER_SECRET\s*=\s*(.*?)\s*$/;
const DEFAULT_CONFIG_PATH = join(homedir(), ".usage-tracker", "config");
const DEFAULT_PRICING_PATH = join(
  homedir(),
  ".usage-tracker",
  "pricing-catalog.json"
);

// Kept in step with Usage Tracker's bundled catalog so governess can price a
// current transcript even when the API reports a bundled (rather than cached)
// catalog. A local Usage Tracker cache overrides these entries when available.
const BUNDLED_PRICING_CATALOG = {
  codex_credit_usd_estimate: { value: 0.04 },
  rates: [
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-fable-5",
      provider: "claude",
      rates: {
        cache_read: 1,
        cache_write: 12.5,
        cache_write_1h: 20,
        input: 10,
        output: 50,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-mythos-5",
      provider: "claude",
      rates: {
        cache_read: 1,
        cache_write: 12.5,
        cache_write_1h: 20,
        input: 10,
        output: 50,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus-5",
      provider: "claude",
      rates: {
        cache_read: 0.5,
        cache_write: 6.25,
        cache_write_1h: 10,
        input: 5,
        output: 25,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus-4-8",
      provider: "claude",
      rates: {
        cache_read: 0.5,
        cache_write: 6.25,
        cache_write_1h: 10,
        input: 5,
        output: 25,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus-4-7",
      provider: "claude",
      rates: {
        cache_read: 0.5,
        cache_write: 6.25,
        cache_write_1h: 10,
        input: 5,
        output: 25,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus-4-6",
      provider: "claude",
      rates: {
        cache_read: 0.5,
        cache_write: 6.25,
        cache_write_1h: 10,
        input: 5,
        output: 25,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus-4-5",
      provider: "claude",
      rates: {
        cache_read: 0.5,
        cache_write: 6.25,
        cache_write_1h: 10,
        input: 5,
        output: 25,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-opus",
      provider: "claude",
      rates: {
        cache_read: 1.5,
        cache_write: 18.75,
        cache_write_1h: 30,
        input: 15,
        output: 75,
      },
    },
    {
      basis: "api_usd_per_mtok",
      effective_from: "2026-06-30T00:00:00Z",
      effective_until: "2026-08-31T23:59:59Z",
      model_prefix: "claude-sonnet-5",
      provider: "claude",
      rates: {
        cache_read: 0.2,
        cache_write: 2.5,
        cache_write_1h: 4,
        input: 2,
        output: 10,
      },
    },
    {
      basis: "api_usd_per_mtok",
      effective_from: "2026-09-01T00:00:00Z",
      model_prefix: "claude-sonnet-5",
      provider: "claude",
      rates: {
        cache_read: 0.3,
        cache_write: 3.75,
        cache_write_1h: 6,
        input: 3,
        output: 15,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-sonnet",
      provider: "claude",
      rates: {
        cache_read: 0.3,
        cache_write: 3.75,
        cache_write_1h: 6,
        input: 3,
        output: 15,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-haiku-3-5",
      provider: "claude",
      rates: {
        cache_read: 0.08,
        cache_write: 1,
        cache_write_1h: 1.6,
        input: 0.8,
        output: 4,
      },
    },
    {
      basis: "api_usd_per_mtok",
      model_prefix: "claude-haiku",
      provider: "claude",
      rates: {
        cache_read: 0.1,
        cache_write: 1.25,
        cache_write_1h: 2,
        input: 1,
        output: 5,
      },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.6-sol",
      provider: "codex",
      rates: { cache_read: 12.5, input: 125, output: 750 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.6-terra",
      provider: "codex",
      rates: { cache_read: 6.25, input: 62.5, output: 375 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.6-luna",
      provider: "codex",
      rates: { cache_read: 2.5, input: 25, output: 150 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.5-cyber",
      provider: "codex",
      rates: { cache_read: 50, input: 500, output: 3000 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.5",
      provider: "codex",
      rates: { cache_read: 12.5, input: 125, output: 750 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.4-mini",
      provider: "codex",
      rates: { cache_read: 1.875, input: 18.75, output: 113 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.4",
      provider: "codex",
      rates: { cache_read: 6.25, input: 62.5, output: 375 },
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.3-codex-spark",
      provider: "codex",
      unpriced_reason: "The research-preview credit rate is not final.",
    },
    {
      basis: "credits_per_mtok",
      effective_from: "2026-04-02T00:00:00Z",
      model_prefix: "gpt-5.3-codex",
      provider: "codex",
      rates: { cache_read: 4.375, input: 43.75, output: 350 },
    },
  ],
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const boundedPct = (value: unknown): number | undefined => {
  const number = finiteNumber(value);
  if (number === undefined) {
    return undefined;
  }
  return Math.round(Math.min(100, Math.max(0, number)) * 10) / 10;
};

const stringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const timestampMs = (value: unknown): number | undefined => {
  const numeric =
    finiteNumber(value) ??
    (typeof value === "string" && NUMERIC_RE.test(value.trim())
      ? Number(value)
      : undefined);
  if (numeric !== undefined) {
    return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
  }
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const limitKind = (value: unknown): UsageLimitKind | undefined => {
  if (value === "session" || value === "weekly" || value === "account") {
    return value;
  }
  return value === "monthly" ? "account" : undefined;
};

const dynamicWindow = (value: unknown): UsageLimitWindow | undefined => {
  const record = asRecord(value);
  const kind = limitKind(record.window_kind);
  const usedPct =
    boundedPct(record.used_pct ?? record.used_percent) ??
    (() => {
      const remaining = boundedPct(
        record.remaining_pct ?? record.remaining_percent
      );
      return remaining === undefined ? undefined : 100 - remaining;
    })();
  if (!(kind && usedPct !== undefined)) {
    return undefined;
  }
  const defaultLabel: Record<UsageLimitKind, string> = {
    account: "Account",
    session: "Session",
    weekly: "Weekly",
  };
  return {
    kind,
    label: stringValue(record.label) ?? defaultLabel[kind],
    model: stringValue(record.model),
    reset: stringValue(record.reset),
    resetAtMs: timestampMs(record.reset_at),
    scopeKind: stringValue(record.scope_kind) ?? "aggregate",
    usedPct,
  };
};

const WINDOW_ORDER: UsageLimitKind[] = ["session", "weekly", "account"];

const preferredWindows = (limits: unknown[]): UsageLimitWindow[] => {
  const parsed = limits
    .map(dynamicWindow)
    .filter((window): window is UsageLimitWindow => window !== undefined);
  return WINDOW_ORDER.flatMap((kind) => {
    const candidates = parsed.filter((window) => window.kind === kind);
    const aggregate = candidates.find(
      (window) => !window.scopeKind || window.scopeKind === "aggregate"
    );
    const fallback = candidates.find((window) => window.scopeKind === "model");
    if (aggregate) {
      return [aggregate];
    }
    return fallback ? [fallback] : [];
  });
};

const legacyQuotaLimit = (
  record: Record<string, unknown>
): AgentUsageLimit | undefined => {
  const primaryPct = boundedPct(record.session_used_pct);
  const primaryReset = stringValue(record.session_reset);
  const secondaryPct = boundedPct(record.weekly_used_pct);
  const secondaryReset = stringValue(record.weekly_reset);
  if (
    primaryPct === undefined &&
    primaryReset === undefined &&
    secondaryPct === undefined &&
    secondaryReset === undefined
  ) {
    return undefined;
  }
  return { primaryPct, primaryReset, secondaryPct, secondaryReset };
};

const quotaLimit = (quota: unknown): AgentUsageLimit | undefined => {
  const record = asRecord(quota);
  if (Array.isArray(record.limits)) {
    const windows = preferredWindows(record.limits);
    if (windows.length > 0) {
      const session = windows.find((window) => window.kind === "session");
      const weekly = windows.find((window) => window.kind === "weekly");
      return {
        primaryPct: session?.usedPct,
        primaryReset: session?.reset,
        secondaryPct: weekly?.usedPct,
        secondaryReset: weekly?.reset,
        windows,
      };
    }
  }
  return legacyQuotaLimit(record);
};

const tokenRates = (value: unknown): TokenRates | undefined => {
  const record = asRecord(value);
  const input = finiteNumber(record.input);
  const output = finiteNumber(record.output);
  const cacheRead = finiteNumber(record.cache_read ?? record.cacheRead);
  if (input === undefined || output === undefined || cacheRead === undefined) {
    return undefined;
  }
  const cacheWrite = finiteNumber(record.cache_write ?? record.cacheWrite);
  const cacheWrite1h = finiteNumber(
    record.cache_write_1h ?? record.cacheWrite1h
  );
  return { cacheRead, cacheWrite, cacheWrite1h, input, output };
};

const pricingRate = (value: unknown): UsageTrackerPricingRate | undefined => {
  const record = asRecord(value);
  const provider = record.provider;
  const basis = record.basis;
  const modelPrefix = stringValue(record.model_prefix ?? record.modelPrefix);
  if (provider !== "claude" && provider !== "codex") {
    return undefined;
  }
  if (basis !== "api_usd_per_mtok" && basis !== "credits_per_mtok") {
    return undefined;
  }
  if (!modelPrefix) {
    return undefined;
  }
  return {
    basis,
    effectiveFromMs: timestampMs(record.effective_from),
    effectiveUntilMs: timestampMs(record.effective_until),
    modelPrefix,
    provider,
    rates: tokenRates(record.rates),
    unpricedReason: stringValue(record.unpriced_reason),
  };
};

const parsePricingCatalog = (
  value: unknown,
  source: string
): UsageTrackerPricing | undefined => {
  const record = asRecord(value);
  if (!Array.isArray(record.rates)) {
    return undefined;
  }
  const rates = record.rates
    .map(pricingRate)
    .filter((rate): rate is UsageTrackerPricingRate => rate !== undefined);
  const credit = finiteNumber(asRecord(record.codex_credit_usd_estimate).value);
  if (rates.length === 0 || credit === undefined || credit < 0) {
    return undefined;
  }
  return { codexCreditUsd: credit, rates, source };
};

const readJsonFile = (path: string): unknown => {
  try {
    return existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : undefined;
  } catch {
    return undefined;
  }
};

const pricingSnapshot = (
  payload: Record<string, unknown>,
  config: UsageTrackerLimitConfig
): UsageTrackerPricing => {
  const status = asRecord(payload.pricing_catalog);
  const liveCredit = finiteNumber(
    asRecord(status.codex_credit_usd_estimate).value
  );
  const inline = parsePricingCatalog(status, "usage-tracker-api");
  const catalogPath =
    config.pricingCatalogPath ??
    stringValue(status.cache_path) ??
    DEFAULT_PRICING_PATH;
  const cached = parsePricingCatalog(readJsonFile(catalogPath), catalogPath);
  const pricing =
    inline ??
    cached ??
    (parsePricingCatalog(
      BUNDLED_PRICING_CATALOG,
      "governess-bundled"
    ) as UsageTrackerPricing);
  return liveCredit === undefined
    ? pricing
    : { ...pricing, codexCreditUsd: liveCredit };
};

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const readConfigSecret = (path: string): string | undefined => {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = line.match(CONFIG_SECRET_RE);
      if (match?.[1]) {
        return stripQuotes(match[1]).trim() || undefined;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const statsUrl = (baseUrl: string): URL =>
  new URL("stats", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

const requestStats = async (
  url: string,
  secret: string,
  timeoutMs: number,
  fetchFn: FetchLike
): Promise<{ payload?: Record<string, unknown>; rejected: boolean }> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(statsUrl(url), {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { rejected: true };
    }
    if (!response.ok) {
      return { rejected: false };
    }
    return {
      payload: asRecord(await response.json()),
      rejected: false,
    };
  } catch {
    return { rejected: false };
  } finally {
    clearTimeout(timeout);
  }
};

export const readUsageTrackerLimits = async (
  config: UsageTrackerLimitConfig,
  fetchFn: FetchLike = fetch
): Promise<UsageLimitSnapshot | undefined> => {
  const url = config.url?.trim();
  if (!url) {
    return undefined;
  }
  const explicitSecret = config.secret?.trim();
  const configSecret = readConfigSecret(
    config.configPath ?? DEFAULT_CONFIG_PATH
  );
  const secrets = [explicitSecret, configSecret].filter(
    (secret, index, values): secret is string =>
      Boolean(secret) && values.indexOf(secret) === index
  );
  if (secrets.length === 0) {
    return undefined;
  }
  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  for (const [index, secret] of secrets.entries()) {
    const response = await requestStats(url, secret, timeoutMs, fetchFn);
    if (response.payload) {
      const snapshot: UsageLimitSnapshot = {
        pricing: pricingSnapshot(response.payload, config),
      };
      const claude = quotaLimit(response.payload.claude_quota);
      const codex = quotaLimit(response.payload.codex_quota);
      if (claude) {
        snapshot.claude = claude;
      }
      if (codex) {
        snapshot.codex = codex;
      }
      return snapshot;
    }
    if (!(response.rejected && index < secrets.length - 1)) {
      return undefined;
    }
  }
  return undefined;
};

const activePricingRate = (
  pricing: UsageTrackerPricing,
  agent: Agent,
  model: string,
  atMs: number
): UsageTrackerPricingRate | undefined => {
  let provider: "claude" | "codex" | undefined;
  if (agent === "claude") {
    provider = "claude";
  } else if (agent === "codex") {
    provider = "codex";
  }
  if (!provider) {
    return undefined;
  }
  const basis = provider === "claude" ? "api_usd_per_mtok" : "credits_per_mtok";
  return pricing.rates
    .filter(
      (rate) =>
        rate.provider === provider &&
        rate.basis === basis &&
        model.startsWith(rate.modelPrefix) &&
        (rate.effectiveFromMs === undefined || atMs >= rate.effectiveFromMs) &&
        (rate.effectiveUntilMs === undefined || atMs <= rate.effectiveUntilMs)
    )
    .sort(
      (a, b) =>
        b.modelPrefix.length - a.modelPrefix.length ||
        (b.effectiveFromMs ?? 0) - (a.effectiveFromMs ?? 0)
    )[0];
};

const applyCostRate = (usage: AgentUsage): void => {
  usage.costRateUsdPerHour = 0;
  if (!(usage.firstTs && usage.lastTs && usage.costUsd > 0)) {
    return;
  }
  const first = Date.parse(usage.firstTs);
  const last = Date.parse(usage.lastTs);
  if (Number.isFinite(first) && Number.isFinite(last) && last > first) {
    usage.costRateUsdPerHour = usage.costUsd / ((last - first) / 3_600_000);
  }
};

export const applyUsageTrackerPricing = (
  usage: AgentUsage,
  agent: Agent,
  pricing: UsageTrackerPricing
): void => {
  const model = usage.model;
  const atMs = timestampMs(usage.lastTs) ?? Date.now();
  const rate = model
    ? activePricingRate(pricing, agent, model, atMs)
    : undefined;
  const rates = rate?.rates;
  const cacheWrite1hTokens = Math.min(
    usage.cacheCreateTokens,
    Math.max(0, usage.cacheCreate1hTokens ?? 0)
  );
  const cacheWrite5mTokens = usage.cacheCreateTokens - cacheWrite1hTokens;
  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreateTokens;
  usage.costUsd = 0;
  usage.estimatedCredits = undefined;
  usage.costEstimateBasis = undefined;
  usage.costEstimateCoveragePct = totalTokens > 0 ? 0 : undefined;
  if (!(rate && rates)) {
    applyCostRate(usage);
    return;
  }
  const normalizedValue =
    (usage.inputTokens * rates.input +
      usage.outputTokens * rates.output +
      usage.cacheReadTokens * rates.cacheRead +
      cacheWrite5mTokens * (rates.cacheWrite ?? 0) +
      cacheWrite1hTokens * (rates.cacheWrite1h ?? rates.cacheWrite ?? 0)) /
    PER_MTOK;
  usage.costEstimateCoveragePct = 100;
  if (rate.basis === "credits_per_mtok") {
    usage.estimatedCredits = normalizedValue;
    usage.costUsd = normalizedValue * pricing.codexCreditUsd;
    usage.costEstimateBasis = "credit-estimate";
  } else {
    usage.costUsd = normalizedValue;
    usage.costEstimateBasis = "api-usd";
  }
  applyCostRate(usage);
};
