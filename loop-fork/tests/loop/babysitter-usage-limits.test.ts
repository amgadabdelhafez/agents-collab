import { expect, test } from "bun:test";
import { readUsageTrackerLimits } from "../../src/loop/babysitter-usage-limits";

test("readUsageTrackerLimits maps usage tracker quotas to agent limits", async () => {
  const requests: Array<{ headers?: HeadersInit; url: string }> = [];
  const result = await readUsageTrackerLimits(
    { secret: "secret", timeoutMs: 500, url: "http://tracker.local" },
    (input, init) => {
      requests.push({
        headers: init?.headers,
        url: input.toString(),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            claude_quota: {
              session_reset: "Jul 5 2:19 PM",
              session_used_pct: 43.22,
              weekly_reset: "Jul 6 5:59 PM",
              weekly_used_pct: 17,
            },
            codex_quota: {
              code_review_used_pct: 88,
              session_reset: "Jul 5 12:00 PM",
              session_used_pct: 12.54,
              weekly_reset: "Jul 6 6:46 PM",
              weekly_used_pct: 31,
            },
          }),
          { status: 200 }
        )
      );
    }
  );

  expect(requests).toEqual([
    {
      headers: { Authorization: "Bearer secret" },
      url: "http://tracker.local/stats",
    },
  ]);
  expect(result).toEqual({
    claude: {
      primaryPct: 43.2,
      primaryReset: "Jul 5 2:19 PM",
      secondaryPct: 17,
      secondaryReset: "Jul 6 5:59 PM",
    },
    codex: {
      primaryPct: 12.5,
      primaryReset: "Jul 5 12:00 PM",
      secondaryPct: 31,
      secondaryReset: "Jul 6 6:46 PM",
    },
  });
});

test("readUsageTrackerLimits is disabled without a bearer secret", async () => {
  let calls = 0;
  const result = await readUsageTrackerLimits(
    { url: "http://tracker.local" },
    () => {
      calls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
  );

  expect(calls).toBe(0);
  expect(result).toBeUndefined();
});

test("readUsageTrackerLimits returns undefined on API failure", async () => {
  const result = await readUsageTrackerLimits(
    { secret: "secret", url: "http://tracker.local" },
    () => Promise.resolve(new Response("Unauthorized", { status: 401 }))
  );

  expect(result).toBeUndefined();
});
