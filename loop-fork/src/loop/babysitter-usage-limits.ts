import type { Agent } from "./types";

export interface AgentUsageLimit {
  primaryPct?: number;
  primaryReset?: string;
  secondaryPct?: number;
  secondaryReset?: string;
}

export type UsageLimitSnapshot = Partial<Record<Agent, AgentUsageLimit>>;

export interface UsageTrackerLimitConfig {
  secret?: string;
  timeoutMs?: number;
  url?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 1500;

const boundedPct = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
};

const stringValue = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const quotaLimit = (quota: unknown): AgentUsageLimit | undefined => {
  if (typeof quota !== "object" || quota === null) {
    return undefined;
  }
  const record = quota as Record<string, unknown>;
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

const statsUrl = (baseUrl: string): URL =>
  new URL("stats", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

export const readUsageTrackerLimits = async (
  config: UsageTrackerLimitConfig,
  fetchFn: FetchLike = fetch
): Promise<UsageLimitSnapshot | undefined> => {
  const secret = config.secret?.trim();
  const url = config.url?.trim();
  if (!(secret && url)) {
    return undefined;
  }

  const timeoutMs =
    typeof config.timeoutMs === "number" && config.timeoutMs > 0
      ? config.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(statsUrl(url), {
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const snapshot: UsageLimitSnapshot = {};
    const claude = quotaLimit(payload.claude_quota);
    const codex = quotaLimit(payload.codex_quota);
    if (claude) {
      snapshot.claude = claude;
    }
    if (codex) {
      snapshot.codex = codex;
    }
    return Object.keys(snapshot).length > 0 ? snapshot : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
};
