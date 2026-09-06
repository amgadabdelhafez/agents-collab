// Remaining credit for an OpenRouter-backed seat.
//
// The Governess pane's LIMITS and RESET cells were blank for the OSS seat
// because the only limits reader we had scraped usage-tracker, which knows
// Claude and Codex quotas and nothing about a routed seat. OpenRouter reports
// both constraints that can stop that seat:
//
//   GET /api/v1/key      the key's own spend cap and when it resets
//   GET /api/v1/credits  the account's prepaid balance, which does not reset
//
// Either can bind first, and on 2026-09-06 they disagreed sharply: the key had
// $166 of its monthly cap left while the account had $8.40 of credit left. So
// this reports the TIGHTER of the two and names which one it is; reporting the
// looser number would have read as healthy while the seat was a day from
// stopping.
//
// Every failure path returns undefined. A missing key, an unreachable API or a
// malformed body must leave the cells blank, never render a fabricated 0%.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsageLimit } from "./governess-usage-limits";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 2500;
const KEY_PREFIX = "sk-or-";

export interface OpenRouterCredit {
  accountRemainingUsd?: number;
  keyRemainingUsd?: number;
  label: string;
  resetLabel?: string;
  usedPct: number;
}

const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(KEY_PREFIX);

// OpenCode stores provider credentials as nested objects; the shape has moved
// between versions, so search rather than index a fixed path. The value is
// returned to the caller and never logged.
const searchForKey = (node: unknown, depth = 0): string | undefined => {
  if (depth > 6 || node === null || typeof node !== "object") {
    return undefined;
  }
  for (const value of Object.values(node as Record<string, unknown>)) {
    if (isKey(value)) {
      return value;
    }
    const found = searchForKey(value, depth + 1);
    if (found) {
      return found;
    }
  }
  return undefined;
};

export const findOpenRouterKey = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string | undefined => {
  const fromEnv = env.OPENROUTER_API_KEY?.trim();
  if (isKey(fromEnv)) {
    return fromEnv;
  }
  for (const path of [
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".config", "opencode", "auth.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const found = searchForKey(parsed);
      if (found) {
        return found;
      }
    } catch {
      // An absent or unreadable credential store is not an error here.
    }
  }
  return undefined;
};

const getJson = async (
  path: string,
  key: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<Record<string, unknown> | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(`${OPENROUTER_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { data?: unknown };
    return body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const pct = (used: number, total: number): number | undefined =>
  total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : undefined;

export const readOpenRouterCredit = async (
  key: string | undefined,
  fetchFn: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<OpenRouterCredit | undefined> => {
  if (!key) {
    return undefined;
  }
  const [keyData, creditData] = await Promise.all([
    getJson("key", key, fetchFn, timeoutMs),
    getJson("credits", key, fetchFn, timeoutMs),
  ]);

  const limit = num(keyData?.limit);
  const limitRemaining = num(keyData?.limit_remaining);
  const keyPct =
    limit !== undefined && limitRemaining !== undefined
      ? pct(limit - limitRemaining, limit)
      : undefined;

  const totalCredits = num(creditData?.total_credits);
  const totalUsage = num(creditData?.total_usage);
  const accountRemaining =
    totalCredits !== undefined && totalUsage !== undefined
      ? totalCredits - totalUsage
      : undefined;
  const accountPct =
    totalCredits !== undefined && totalUsage !== undefined
      ? pct(totalUsage, totalCredits)
      : undefined;

  if (keyPct === undefined && accountPct === undefined) {
    return undefined;
  }
  const accountBinds =
    keyPct === undefined || (accountPct !== undefined && accountPct >= keyPct);
  const resetRaw = keyData?.limit_reset;

  return {
    accountRemainingUsd: accountRemaining,
    keyRemainingUsd: limitRemaining,
    label: accountBinds ? "openrouter credits" : "openrouter key cap",
    // Prepaid credit does not reset; only the key's own cap does.
    resetLabel:
      accountBinds || typeof resetRaw !== "string" ? undefined : resetRaw,
    usedPct: accountBinds ? (accountPct as number) : (keyPct as number),
  };
};

export const openRouterAgentLimit = (
  credit: OpenRouterCredit | undefined
): AgentUsageLimit | undefined =>
  credit
    ? {
        windows: [
          {
            kind: "account" as const,
            label: credit.label,
            reset: credit.resetLabel,
            usedPct: credit.usedPct,
          },
        ],
      }
    : undefined;
