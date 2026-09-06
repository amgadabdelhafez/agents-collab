import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOpenRouterKey,
  openRouterAgentLimit,
  readOpenRouterCredit,
} from "../../src/loop/openrouter-usage";

const KEY = "sk-or-v1-testkeytestkeytestkey";

const stubFetch = (
  bodies: Record<string, unknown>,
  seen?: { auth: string[]; urls: string[] }
): typeof fetch =>
  ((url: string, init?: RequestInit) => {
    seen?.urls.push(url);
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    if (auth) {
      seen?.auth.push(auth);
    }
    const path = url.split("/v1/")[1] ?? "";
    const body = bodies[path];
    if (body === undefined) {
      return Promise.resolve(new Response("nope", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ data: body }), { status: 200 })
    );
  }) as unknown as typeof fetch;

describe("finding the key", () => {
  test("prefers the environment, then the OpenCode credential store", () => {
    const home = mkdtempSync(join(tmpdir(), "or-home-"));
    expect(findOpenRouterKey({} as NodeJS.ProcessEnv, home)).toBeUndefined();
    expect(
      findOpenRouterKey(
        { OPENROUTER_API_KEY: KEY } as unknown as NodeJS.ProcessEnv,
        home
      )
    ).toBe(KEY);

    const dir = join(home, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api", key: KEY } })
    );
    expect(findOpenRouterKey({} as NodeJS.ProcessEnv, home)).toBe(KEY);
  });

  test("a value that is not an OpenRouter key is never returned", () => {
    const home = mkdtempSync(join(tmpdir(), "or-home2-"));
    expect(
      findOpenRouterKey(
        {
          OPENROUTER_API_KEY: "sk-ant-something",
        } as unknown as NodeJS.ProcessEnv,
        home
      )
    ).toBeUndefined();
  });
});

describe("reading the credit", () => {
  test("reports the tighter of the account balance and the key cap", async () => {
    // The live 2026-09-06 numbers: the key looks healthy, the account does not.
    const credit = await readOpenRouterCredit(
      KEY,
      stubFetch({
        credits: { total_credits: 808, total_usage: 799.597_488_491 },
        key: { limit: 200, limit_remaining: 166.09, limit_reset: "monthly" },
      })
    );
    expect(credit?.label).toBe("openrouter credits");
    expect(credit?.usedPct).toBeCloseTo(98.96, 1);
    expect(credit?.accountRemainingUsd).toBeCloseTo(8.4, 1);
    // Prepaid credit does not reset, so no reset is claimed for it.
    expect(credit?.resetLabel).toBeUndefined();
  });

  test("when the key cap binds first it is reported instead, with its reset", async () => {
    const credit = await readOpenRouterCredit(
      KEY,
      stubFetch({
        credits: { total_credits: 1000, total_usage: 10 },
        key: { limit: 200, limit_remaining: 4, limit_reset: "monthly" },
      })
    );
    expect(credit?.label).toBe("openrouter key cap");
    expect(credit?.usedPct).toBeCloseTo(98, 1);
    expect(credit?.resetLabel).toBe("monthly");
  });

  test("the key travels in the Authorization header, never in the URL", async () => {
    const seen = { auth: [] as string[], urls: [] as string[] };
    await readOpenRouterCredit(
      KEY,
      stubFetch(
        {
          credits: { total_credits: 10, total_usage: 1 },
          key: { limit: 5, limit_remaining: 5 },
        },
        seen
      )
    );
    expect(seen.urls.length).toBe(2);
    for (const url of seen.urls) {
      expect(url).not.toContain(KEY);
    }
    expect(seen.auth).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
  });

  test("every failure is blank, never a fabricated zero", async () => {
    expect(
      await readOpenRouterCredit(undefined, stubFetch({}))
    ).toBeUndefined();
    // Both endpoints 404.
    expect(await readOpenRouterCredit(KEY, stubFetch({}))).toBeUndefined();
    // Present but unusable numbers.
    expect(
      await readOpenRouterCredit(
        KEY,
        stubFetch({ credits: { total_credits: 0 }, key: { limit: 0 } })
      )
    ).toBeUndefined();
    const thrower = (() =>
      Promise.reject(new Error("network"))) as unknown as typeof fetch;
    expect(await readOpenRouterCredit(KEY, thrower)).toBeUndefined();
  });
});

describe("the pane limit window", () => {
  test("an absent credit yields no window at all", () => {
    expect(openRouterAgentLimit(undefined)).toBeUndefined();
  });

  test("a credit becomes one account window the pane can render", () => {
    const limit = openRouterAgentLimit({
      label: "openrouter credits",
      usedPct: 98.96,
    });
    expect(limit?.windows?.length).toBe(1);
    expect(limit?.windows?.[0]?.kind).toBe("account");
    expect(limit?.windows?.[0]?.usedPct).toBeCloseTo(98.96, 2);
  });
});
