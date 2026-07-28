import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCostBucket,
  emptyTokens,
  type ModelUsageRow,
  type PricingCatalog,
  priceRow,
  readPricingCatalog,
  unavailableCost,
} from "../../src/loop/ledger-cost";

const catalog: PricingCatalog = {
  creditUsd: 0.04,
  path: "/test/pricing_catalog.json",
  rates: [
    {
      basis: "api_usd_per_mtok",
      modelPrefix: "claude-opus",
      provider: "claude",
      rates: { cache_read: 1.5, cache_write: 18.75, input: 15, output: 75 },
    },
    {
      basis: "api_usd_per_mtok",
      modelPrefix: "claude-opus-5",
      provider: "claude",
      rates: { cache_read: 0.5, cache_write: 6.25, input: 5, output: 25 },
    },
    {
      basis: "credits_per_mtok",
      modelPrefix: "gpt-5.5",
      provider: "codex",
      rates: { cache_read: 12.5, input: 125, output: 750 },
    },
  ],
};

const row = (over: Partial<ModelUsageRow>): ModelUsageRow => ({
  cacheRead: 0,
  cacheWrite1h: 0,
  cacheWrite5m: 0,
  input: 0,
  model: "claude-opus-5",
  output: 0,
  provider: "claude",
  reasoning: 0,
  ...over,
});

describe("priceRow", () => {
  test("prefers the longest matching model prefix", () => {
    // 1M input at the opus-5 rate is $5, not the generic opus $15.
    const usd = priceRow(catalog, row({ input: 1_000_000 }));
    expect(usd).toBe(5);
  });

  test("converts codex credit rates to usd", () => {
    // 1M output = 750 credits * $0.04 = $30.
    const usd = priceRow(
      catalog,
      row({ model: "gpt-5.5", output: 1_000_000, provider: "codex" })
    );
    expect(usd).toBe(30);
  });

  test("returns undefined for a model with no catalog rate", () => {
    expect(priceRow(catalog, row({ model: "mystery-9" }))).toBeUndefined();
  });

  test("prices each token class separately", () => {
    const usd = priceRow(
      catalog,
      row({ cacheRead: 2_000_000, cacheWrite5m: 1_000_000 })
    );
    expect(usd).toBeCloseTo(2 * 0.5 + 6.25, 6);
  });
});

describe("buildCostBucket", () => {
  test("sums tokens and usd across model rows", () => {
    const result = buildCostBucket(
      "direct",
      2,
      [row({ input: 1_000_000 }), row({ output: 1_000_000 })],
      catalog
    );
    expect(result.bucket.sessions).toBe(2);
    expect(result.bucket.tokens.total).toBe(2_000_000);
    expect(result.bucket.usd).toBe(30);
    expect(result.unpricedModels).toEqual([]);
  });

  test("omits usd entirely when no catalog is available", () => {
    const result = buildCostBucket(
      "direct",
      1,
      [row({ input: 1_000_000 })],
      undefined
    );
    expect(result.bucket.usd).toBeUndefined();
    expect(result.bucket.tokens.input).toBe(1_000_000);
  });

  test("reports unpriced models instead of counting them as free", () => {
    const result = buildCostBucket(
      "direct",
      1,
      [row({ input: 500, model: "mystery-9" })],
      catalog
    );
    expect(result.unpricedModels).toEqual(["claude/mystery-9"]);
    expect(result.bucket.usd).toBe(0);
  });

  test("ignores zero-token rows when flagging unpriced models", () => {
    // 'unknown' model rows carry no tokens; they must not pollute coverage.
    const result = buildCostBucket(
      "direct",
      1,
      [row({ model: "unknown" })],
      catalog
    );
    expect(result.unpricedModels).toEqual([]);
  });

  test("accumulates 1h cache writes into the cacheWrite total", () => {
    const result = buildCostBucket(
      "direct",
      1,
      [row({ cacheWrite1h: 10, cacheWrite5m: 5 })],
      catalog
    );
    expect(result.bucket.tokens.cacheWrite).toBe(15);
  });
});

describe("readPricingCatalog", () => {
  test("returns undefined when no candidate path exists", () => {
    expect(readPricingCatalog(["/nope/missing.json"])).toBeUndefined();
  });

  test("parses a catalog and skips entries without rates", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-cat-"));
    const path = join(dir, "pricing_catalog.json");
    writeFileSync(
      path,
      JSON.stringify({
        codex_credit_usd_estimate: { value: 0.04 },
        rates: [
          { basis: "x", model_prefix: "unpriced", provider: "codex" },
          {
            basis: "api_usd_per_mtok",
            model_prefix: "claude-opus-5",
            provider: "claude",
            rates: { input: 5 },
          },
        ],
      })
    );
    const parsed = readPricingCatalog([path]);
    expect(parsed?.rates).toHaveLength(1);
    expect(parsed?.creditUsd).toBe(0.04);
  });

  test("treats a malformed catalog as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-bad-"));
    const path = join(dir, "pricing_catalog.json");
    writeFileSync(path, "{not json");
    expect(readPricingCatalog([path])).toBeUndefined();
  });
});

describe("unavailableCost", () => {
  test("carries the reason and omits dollar figures", () => {
    const cost = unavailableCost("unavailable-no-database");
    expect(cost.basis).toBe("unavailable-no-database");
    expect(cost.direct.usd).toBeUndefined();
    expect(cost.direct.tokens).toEqual(emptyTokens());
  });
});
