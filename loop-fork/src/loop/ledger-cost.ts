/**
 * Cost attribution for loop outcome records.
 *
 * This module deliberately does NOT define its own pricing table. The machine
 * already runs usage-tracker, which owns `~/.usage-tracker/activity.db` and a
 * versioned `pricing_catalog.json`. We read both. When the catalog cannot be
 * found we emit token counts with NO dollar figure rather than inventing one.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  LedgerCost,
  LedgerCostBucket,
  LedgerCostScope,
  LedgerReadMode,
  LedgerTokens,
} from "./ledger-types";

const PER_MTOK = 1_000_000;
const SQLITE_BUSY_TIMEOUT_MS = 5000;

export const ACTIVITY_DB_PATH = join(
  homedir(),
  ".usage-tracker",
  "activity.db"
);

/**
 * The catalog ships inside the usage-tracker checkout rather than the data dir,
 * so there is no single stable path. Probe known locations, newest wins, and
 * degrade cleanly when none exist.
 */
const CATALOG_CANDIDATES: string[] = [
  join(homedir(), ".usage-tracker", "pricing_catalog.json"),
  join(
    homedir(),
    "dev_projects",
    "usage-tracker",
    "src",
    "pricing_catalog.json"
  ),
  join(
    homedir(),
    "dev_projects",
    "usage-tracker-runtime",
    "src",
    "pricing_catalog.json"
  ),
];

interface CatalogRate {
  basis: string;
  modelPrefix: string;
  provider: string;
  rates: Record<string, number>;
}

export interface PricingCatalog {
  creditUsd: number;
  path: string;
  rates: CatalogRate[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const numberOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const parseRate = (entry: unknown): CatalogRate | undefined => {
  const row = asRecord(entry);
  const provider = row.provider;
  const modelPrefix = row.model_prefix;
  const basis = row.basis;
  const rates = row.rates;
  // Entries may legitimately omit `rates` (catalog marks them unpriced_reason).
  if (
    typeof provider !== "string" ||
    typeof modelPrefix !== "string" ||
    typeof basis !== "string" ||
    typeof rates !== "object" ||
    rates === null
  ) {
    return undefined;
  }
  const parsed: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    parsed[key] = numberOf(value);
  }
  return { basis, modelPrefix, provider, rates: parsed };
};

export const readPricingCatalog = (
  candidates: string[] = CATALOG_CANDIDATES
): PricingCatalog | undefined => {
  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")));
      const rawRates = Array.isArray(parsed.rates) ? parsed.rates : [];
      const rates: CatalogRate[] = [];
      for (const entry of rawRates) {
        const rate = parseRate(entry);
        if (rate) {
          rates.push(rate);
        }
      }
      if (rates.length === 0) {
        continue;
      }
      const credit = numberOf(asRecord(parsed.codex_credit_usd_estimate).value);
      return { creditUsd: credit, path, rates };
    } catch {
      // Malformed catalog is treated as absent, not as zero-cost.
    }
  }
  return undefined;
};

/** Longest matching model prefix wins, so `claude-opus-5` beats `claude-opus`. */
const matchRate = (
  catalog: PricingCatalog,
  provider: string,
  model: string
): CatalogRate | undefined => {
  let best: CatalogRate | undefined;
  for (const rate of catalog.rates) {
    if (rate.provider !== provider || !model.startsWith(rate.modelPrefix)) {
      continue;
    }
    if (!best || rate.modelPrefix.length > best.modelPrefix.length) {
      best = rate;
    }
  }
  return best;
};

export interface ModelUsageRow {
  cacheRead: number;
  cacheWrite1h: number;
  cacheWrite5m: number;
  input: number;
  model: string;
  output: number;
  provider: string;
  reasoning: number;
}

export const emptyTokens = (): LedgerTokens => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  total: 0,
});

const addRowTokens = (tokens: LedgerTokens, row: ModelUsageRow): void => {
  tokens.input += row.input;
  tokens.output += row.output;
  tokens.cacheRead += row.cacheRead;
  tokens.cacheWrite += row.cacheWrite5m + row.cacheWrite1h;
  tokens.reasoning += row.reasoning;
  tokens.total +=
    row.input +
    row.output +
    row.cacheRead +
    row.cacheWrite5m +
    row.cacheWrite1h;
};

/** Billable token volume, used to decide whether an unpriced model matters. */
const billableTokens = (row: ModelUsageRow): number =>
  row.input + row.output + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h;

export const priceRow = (
  catalog: PricingCatalog,
  row: ModelUsageRow
): number | undefined => {
  const rate = matchRate(catalog, row.provider, row.model);
  if (!rate) {
    return undefined;
  }
  const r = rate.rates;
  const raw =
    (row.input * (r.input ?? 0) +
      row.output * (r.output ?? 0) +
      row.cacheRead * (r.cache_read ?? 0) +
      row.cacheWrite5m * (r.cache_write ?? 0) +
      row.cacheWrite1h * (r.cache_write_1h ?? 0)) /
    PER_MTOK;
  return rate.basis === "credits_per_mtok" ? raw * catalog.creditUsd : raw;
};

export interface CostBucketResult {
  bucket: LedgerCostBucket;
  unpricedModels: string[];
}

export const buildCostBucket = (
  scope: LedgerCostScope,
  sessions: number,
  rows: ModelUsageRow[],
  catalog: PricingCatalog | undefined
): CostBucketResult => {
  const tokens = emptyTokens();
  const unpriced = new Set<string>();
  let usd = 0;
  for (const row of rows) {
    addRowTokens(tokens, row);
    if (!catalog || billableTokens(row) === 0) {
      continue;
    }
    const priced = priceRow(catalog, row);
    if (priced === undefined) {
      unpriced.add(`${row.provider}/${row.model}`);
      continue;
    }
    usd += priced;
  }
  return {
    bucket: {
      scope,
      sessions,
      tokens,
      ...(catalog ? { usd: Math.round(usd * 100) / 100 } : {}),
    },
    unpricedModels: [...unpriced].sort(),
  };
};

const USAGE_BY_SESSIONS_SQL = `
  SELECT provider, model,
    SUM(input_tokens) AS input,
    SUM(output_tokens) AS output,
    SUM(cache_read_tokens) AS cache_read,
    SUM(cache_write_5m_tokens) AS cache_write_5m,
    SUM(cache_write_1h_tokens) AS cache_write_1h,
    SUM(reasoning_tokens) AS reasoning
  FROM usage_events
  WHERE session_id IN (SELECT value FROM json_each(?))
  GROUP BY provider, model`;

const toRow = (raw: unknown): ModelUsageRow => {
  const r = asRecord(raw);
  return {
    cacheRead: numberOf(r.cache_read),
    cacheWrite1h: numberOf(r.cache_write_1h),
    cacheWrite5m: numberOf(r.cache_write_5m),
    input: numberOf(r.input),
    model: typeof r.model === "string" ? r.model : "unknown",
    output: numberOf(r.output),
    provider: typeof r.provider === "string" ? r.provider : "unknown",
    reasoning: numberOf(r.reasoning),
  };
};

export interface ActivityReader {
  close: () => void;
  readMode: LedgerReadMode;
  /**
   * Session ids active in [startUs, endUs] under any of the given cwd prefixes.
   * Returns undefined when the query fails, which must never be conflated with
   * "no sessions" — that would silently report a cost of zero.
   */
  sessionsInWindow: (
    startUs: number,
    endUs: number,
    cwdPrefixes: string[]
  ) => string[] | undefined;
  usageForSessions: (sessionIds: string[]) => ModelUsageRow[] | undefined;
}

/**
 * Opens activity.db without taking a write lock.
 *
 * A plain read-only open fails with SQLITE_CANTOPEN against a live WAL database
 * that has no -shm file, because a read-only connection cannot create one. We
 * therefore fall back to an immutable open, which bypasses locking and shared
 * memory entirely and so cannot interfere with usage-tracker's writer.
 */
const openDatabase = (
  path: string
): { db: Database; readMode: LedgerReadMode } | undefined => {
  try {
    const db = new Database(path, { readonly: true });
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.query("SELECT 1 FROM usage_events LIMIT 1").get();
    return { db, readMode: "readonly" };
  } catch {
    // fall through to an immutable read
  }
  try {
    const db = new Database(`file:${path}?mode=ro&immutable=1`, {
      readonly: true,
    });
    db.query("SELECT 1 FROM usage_events LIMIT 1").get();
    return { db, readMode: "immutable" };
  } catch {
    return undefined;
  }
};

export const openActivityDb = (
  path: string = ACTIVITY_DB_PATH
): ActivityReader | undefined => {
  if (!existsSync(path)) {
    return undefined;
  }
  const opened = openDatabase(path);
  if (!opened) {
    return undefined;
  }
  const { db, readMode } = opened;
  return {
    close: () => db.close(),
    readMode,
    sessionsInWindow: (startUs, endUs, cwdPrefixes) => {
      if (cwdPrefixes.length === 0) {
        return [];
      }
      const clause = cwdPrefixes.map(() => "cwd LIKE ?").join(" OR ");
      const sql = `SELECT session_id, MIN(timestamp_us) AS first_us
        FROM usage_events WHERE (${clause})
        GROUP BY session_id HAVING first_us >= ? AND first_us <= ?`;
      const args = [...cwdPrefixes.map((p) => `${p}%`), startUs, endUs];
      try {
        return db
          .query(sql)
          .all(...args)
          .map((row) => String(asRecord(row).session_id ?? ""))
          .filter((id) => id.length > 0);
      } catch {
        return undefined;
      }
    },
    usageForSessions: (sessionIds) => {
      if (sessionIds.length === 0) {
        return [];
      }
      try {
        return db
          .query(USAGE_BY_SESSIONS_SQL)
          .all(JSON.stringify(sessionIds))
          .map(toRow);
      } catch {
        return undefined;
      }
    },
  };
};

export const unavailableCost = (basis: LedgerCost["basis"]): LedgerCost => ({
  basis,
  direct: { scope: "direct", sessions: 0, tokens: emptyTokens() },
  unpricedModels: [],
  windowed: { scope: "windowed", sessions: 0, tokens: emptyTokens() },
});
