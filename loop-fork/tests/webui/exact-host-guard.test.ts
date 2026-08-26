import { describe, expect, test } from "bun:test";

import { handleExactHostRequest } from "../../src/webui/server/exact-host-guard";

const expectedHosts = [
  "100.64.0.14:46327",
  "sweetmac14.sweet.home:46327",
] as const;

describe("Web UI exact Host guard", () => {
  test("allows only an exact configured IP or MagicDNS Host", () => {
    expect(
      handleExactHostRequest(
        { host: expectedHosts[0], url: "/" },
        expectedHosts
      )
    ).toBeUndefined();
    expect(
      handleExactHostRequest(
        { host: expectedHosts[1], url: "/main.tsx" },
        expectedHosts
      )
    ).toBeUndefined();
  });

  test("rejects unrelated numeric Hosts before every route", () => {
    for (const url of ["/", "/main.tsx", "/api/v1/live-snapshot"]) {
      expect(
        handleExactHostRequest(
          { host: "100.64.0.15:46327", url },
          expectedHosts
        )
      ).toEqual({
        body: '{"code":"HOST_REJECTED","error":"Host rejected"}',
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Content-Security-Policy":
            "default-src 'none'; frame-ancestors 'none'",
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
        status: 403,
      });
    }
  });

  test("rejects missing, malformed, case-varied, and port-mismatched Hosts", () => {
    for (const host of [
      undefined,
      "",
      "100.64.0.14",
      "100.64.0.14:46328",
      "SweetMac14.sweet.home:46327",
      "sweetmac14.sweet.home.:46327",
    ]) {
      expect(
        handleExactHostRequest({ host, url: "/" }, expectedHosts)?.status
      ).toBe(403);
    }
  });
});
