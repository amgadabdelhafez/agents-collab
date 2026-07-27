import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUsageTrackerPricing,
  createStableUsageLimitReader,
  readUsageTrackerLimits,
} from "../../src/loop/governess-usage-limits";
import type { AgentUsage } from "../../src/loop/types";

const noConfig = "/definitely/missing/usage-tracker-config";

const usage = (model: string): AgentUsage => ({
  cacheCreateTokens: 0,
  cacheReadTokens: 1_000_000,
  compactedContextTokens: 0,
  compactions: 0,
  contextRateTokensPerMinute: 0,
  contextTokens: 0,
  contextWindow: 200_000,
  costRateUsdPerHour: 0,
  costUsd: 0,
  dataConfidence: "exact",
  firstTs: "2026-07-25T10:00:00Z",
  humanMessages: 0,
  inputTokens: 1_000_000,
  lastTs: "2026-07-25T11:00:00Z",
  messages: 0,
  model,
  outputTokens: 1_000_000,
  textMessages: 0,
  thinkingMessages: 0,
  toolCallCounts: {},
  toolCalls: 0,
  totalTokens: 3_000_000,
});

test("readUsageTrackerLimits keeps legacy scalar quota compatibility", async () => {
  const requests: Array<{ headers?: HeadersInit; url: string }> = [];
  const result = await readUsageTrackerLimits(
    {
      configPath: noConfig,
      secret: "secret",
      timeoutMs: 500,
      url: "http://tracker.local",
    },
    (input, init) => {
      requests.push({ headers: init?.headers, url: input.toString() });
      return Promise.resolve(
        Response.json({
          claude_quota: {
            session_reset: "Jul 5 2:19 PM",
            session_used_pct: 43.22,
            weekly_reset: "Jul 6 5:59 PM",
            weekly_used_pct: 17,
          },
          codex_quota: {
            session_reset: "Jul 5 12:00 PM",
            session_used_pct: 12.54,
            weekly_reset: "Jul 6 6:46 PM",
            weekly_used_pct: 31,
          },
        })
      );
    }
  );

  expect(requests).toEqual([
    {
      headers: { Authorization: "Bearer secret" },
      url: "http://tracker.local/stats",
    },
  ]);
  expect(result?.claude).toEqual({
    primaryPct: 43.2,
    primaryReset: "Jul 5 2:19 PM",
    secondaryPct: 17,
    secondaryReset: "Jul 6 5:59 PM",
  });
  expect(result?.codex).toEqual({
    primaryPct: 12.5,
    primaryReset: "Jul 5 12:00 PM",
    secondaryPct: 31,
    secondaryReset: "Jul 6 6:46 PM",
  });
});

test("dynamic aggregate limits suppress model limits and fabricated sessions", async () => {
  const result = await readUsageTrackerLimits(
    {
      configPath: noConfig,
      secret: "secret",
      url: "http://tracker.local",
    },
    () =>
      Promise.resolve(
        Response.json({
          claude_quota: {
            limits: [
              {
                label: "Session",
                reset: "Jul 25 2:30 PM",
                scope_kind: "aggregate",
                used_pct: 81.24,
                window_kind: "session",
              },
              {
                label: "Weekly",
                reset: "Jul 27 6:00 PM",
                scope_kind: "aggregate",
                used_pct: 41,
                window_kind: "weekly",
              },
              {
                label: "Opus weekly",
                model: "claude-opus-5",
                scope_kind: "model",
                used_pct: 99,
                window_kind: "weekly",
              },
            ],
          },
          codex_quota: {
            limits: [
              {
                label: "Sol weekly",
                model: "gpt-5.6-sol",
                reset_at: 1_800_000_100,
                scope_kind: "model",
                used_pct: 0,
                window_kind: "weekly",
              },
              {
                label: "Weekly",
                reset_at: 1_800_000_000,
                scope_kind: "aggregate",
                used_pct: 14,
                window_kind: "weekly",
              },
            ],
            session_reset: "incorrect legacy session",
            session_used_pct: 88,
          },
        })
      )
  );

  expect(result?.claude?.windows).toEqual([
    {
      kind: "session",
      label: "Session",
      model: undefined,
      reset: "Jul 25 2:30 PM",
      resetAtMs: undefined,
      scopeKind: "aggregate",
      usedPct: 81.2,
    },
    {
      kind: "weekly",
      label: "Weekly",
      model: undefined,
      reset: "Jul 27 6:00 PM",
      resetAtMs: undefined,
      scopeKind: "aggregate",
      usedPct: 41,
    },
  ]);
  expect(result?.codex?.primaryPct).toBeUndefined();
  expect(result?.codex?.secondaryPct).toBe(14);
  expect(result?.codex?.windows).toEqual([
    {
      kind: "weekly",
      label: "Weekly",
      model: undefined,
      reset: undefined,
      resetAtMs: 1_800_000_000_000,
      scopeKind: "aggregate",
      usedPct: 14,
    },
  ]);
});

test("a rejected explicit secret retries the working config secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "governess-usage-token-"));
  const configPath = join(dir, "config");
  writeFileSync(configPath, "USAGE_TRACKER_SECRET='working-token'\n");
  const auth: string[] = [];
  const result = await readUsageTrackerLimits(
    {
      configPath,
      secret: "stale-token",
      url: "http://tracker.local",
    },
    (_input, init) => {
      const header = (init?.headers as Record<string, string>).Authorization;
      auth.push(header);
      return Promise.resolve(
        header === "Bearer working-token"
          ? Response.json({
              claude_quota: { session_used_pct: 55 },
            })
          : new Response("Unauthorized", { status: 401 })
      );
    }
  );

  expect(auth).toEqual(["Bearer stale-token", "Bearer working-token"]);
  expect(result?.claude?.primaryPct).toBe(55);
});

test("current Claude and Codex models use catalog replacement-value pricing", async () => {
  const result = await readUsageTrackerLimits(
    {
      configPath: noConfig,
      secret: "secret",
      url: "http://tracker.local",
    },
    () =>
      Promise.resolve(
        Response.json({
          pricing_catalog: {
            codex_credit_usd_estimate: { value: 0.04 },
          },
        })
      )
  );
  const pricing = result?.pricing;
  expect(pricing).toBeDefined();
  if (!pricing) {
    throw new Error("expected pricing snapshot");
  }

  const claude = usage("claude-opus-5");
  claude.cacheCreateTokens = 1_000_000;
  claude.cacheCreate1hTokens = 1_000_000;
  applyUsageTrackerPricing(claude, "claude", pricing);
  expect(claude.costUsd).toBe(40.5);
  expect(claude.costEstimateBasis).toBe("api-usd");
  expect(claude.costEstimateCoveragePct).toBe(100);

  const codex = usage("gpt-5.6-sol");
  applyUsageTrackerPricing(codex, "codex", pricing);
  expect(codex.estimatedCredits).toBe(887.5);
  expect(codex.costUsd).toBe(35.5);
  expect(codex.costEstimateBasis).toBe("credit-estimate");
  expect(codex.costEstimateCoveragePct).toBe(100);
});

test("transient tracker failures retain local pricing without quotas", async () => {
  const config = {
    configPath: noConfig,
    pricingCatalogPath: noConfig,
    secret: "secret",
    url: "http://tracker.local",
  };
  const successful = await readUsageTrackerLimits(config, () =>
    Promise.resolve(
      Response.json({
        codex_quota: { weekly_used_pct: 8 },
        pricing_catalog: {
          codex_credit_usd_estimate: { value: 0.04 },
        },
      })
    )
  );
  const successfulUsage = usage("gpt-5.6-sol");
  if (!successful?.pricing) {
    throw new Error("expected successful pricing snapshot");
  }
  applyUsageTrackerPricing(successfulUsage, "codex", successful.pricing);

  const failures = [
    () => Promise.reject(new Error("The operation was aborted.")),
    () => Promise.resolve(new Response("Unavailable", { status: 503 })),
  ];
  for (const fetchFn of failures) {
    const fallback = await readUsageTrackerLimits(config, fetchFn);
    expect(fallback?.claude).toBeUndefined();
    expect(fallback?.codex).toBeUndefined();
    expect(fallback?.pricing).toBeDefined();
    if (!fallback?.pricing) {
      throw new Error("expected fallback pricing snapshot");
    }
    const fallbackUsage = usage("gpt-5.6-sol");
    applyUsageTrackerPricing(fallbackUsage, "codex", fallback.pricing);
    expect(fallbackUsage.costUsd).toBe(successfulUsage.costUsd);
    expect(fallbackUsage.costRateUsdPerHour).toBe(
      successfulUsage.costRateUsdPerHour
    );
  }
});

test("stable reader retains fresh per-provider quotas through transient gaps", async () => {
  const clock = { ms: 1000 };
  const responses: Array<() => Promise<Response>> = [
    () =>
      Promise.resolve(
        Response.json({
          claude_quota: { weekly_used_pct: 26 },
          codex_quota: { weekly_used_pct: 8 },
          pricing_catalog: {
            codex_credit_usd_estimate: { value: 0.04 },
          },
        })
      ),
    () => Promise.reject(new Error("The operation was aborted.")),
    () =>
      Promise.resolve(Response.json({ claude_quota: { weekly_used_pct: 27 } })),
    () => Promise.resolve(new Response("Unavailable", { status: 503 })),
  ];
  const read = createStableUsageLimitReader(
    () => (responses.shift() as () => Promise<Response>)(),
    () => clock.ms,
    60_000
  );
  const config = {
    configPath: noConfig,
    pricingCatalogPath: noConfig,
    secret: "secret",
    url: "http://tracker.local",
  };

  const fresh = await read(config);
  expect(fresh?.claude?.secondaryPct).toBe(26);
  expect(fresh?.codex?.secondaryPct).toBe(8);

  clock.ms += 10_000;
  const transient = await read(config);
  expect(transient?.claude?.secondaryPct).toBe(26);
  expect(transient?.codex?.secondaryPct).toBe(8);
  expect(transient?.pricing).toBeDefined();

  clock.ms += 10_000;
  const partial = await read(config);
  expect(partial?.claude?.secondaryPct).toBe(27);
  expect(partial?.codex?.secondaryPct).toBe(8);

  clock.ms += 60_001;
  const expired = await read(config);
  expect(expired?.claude).toBeUndefined();
  expect(expired?.codex).toBeUndefined();
  expect(expired?.pricing).toBeDefined();
});

test("stable reader clears retained quotas after authentication failure", async () => {
  const responses: Array<() => Promise<Response>> = [
    () =>
      Promise.resolve(Response.json({ codex_quota: { weekly_used_pct: 8 } })),
    () => Promise.resolve(new Response("Unauthorized", { status: 401 })),
    () => Promise.reject(new Error("The operation was aborted.")),
  ];
  const read = createStableUsageLimitReader(() =>
    (responses.shift() as () => Promise<Response>)()
  );
  const config = {
    configPath: noConfig,
    pricingCatalogPath: noConfig,
    secret: "secret",
    url: "http://tracker.local",
  };

  expect((await read(config))?.codex?.secondaryPct).toBe(8);
  expect(await read(config)).toBeUndefined();
  const afterRejection = await read(config);
  expect(afterRejection?.codex).toBeUndefined();
  expect(afterRejection?.pricing).toBeDefined();
});

test("readUsageTrackerLimits is disabled without any configured secret", async () => {
  let calls = 0;
  const result = await readUsageTrackerLimits(
    { configPath: noConfig, url: "http://tracker.local" },
    () => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    }
  );

  expect(calls).toBe(0);
  expect(result).toBeUndefined();
});

test("readUsageTrackerLimits returns undefined after authentication failure", async () => {
  const result = await readUsageTrackerLimits(
    {
      configPath: noConfig,
      secret: "secret",
      url: "http://tracker.local",
    },
    () => Promise.resolve(new Response("Unauthorized", { status: 401 }))
  );

  expect(result).toBeUndefined();
});
