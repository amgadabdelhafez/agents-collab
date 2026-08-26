import { describe, expect, test } from "bun:test";

import {
  buildTailnetUrls,
  parseTailscaleStatus,
  resolveWebUiServerEnvironment,
} from "../../src/webui/tailscale";

const runningStatus = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "sweetmac14.sweet.home.",
    Online: true,
  },
  TUN: true,
  TailscaleIPs: ["100.64.0.14", "fd7a:115c:a1e0::e"],
});

describe("Tailscale Web UI binding", () => {
  test("resolves the exact private IPv4 and normalized MagicDNS host", () => {
    expect(parseTailscaleStatus(runningStatus)).toEqual({
      dnsName: "sweetmac14.sweet.home",
      ipv4: "100.64.0.14",
    });
  });

  test("builds private IP and MagicDNS URLs", () => {
    expect(
      buildTailnetUrls(
        { dnsName: "sweetmac14.sweet.home", ipv4: "100.64.0.14" },
        46_327
      )
    ).toEqual([
      "http://100.64.0.14:46327/",
      "http://sweetmac14.sweet.home:46327/",
    ]);
  });

  test("fails closed for malformed or unhealthy status", () => {
    expect(() => parseTailscaleStatus("not json")).toThrow(
      "Tailscale status was not valid JSON"
    );
    expect(() =>
      parseTailscaleStatus(
        JSON.stringify({
          BackendState: "Stopped",
          Self: { DNSName: "mac.example.", Online: true },
          TUN: true,
          TailscaleIPs: ["100.64.0.14"],
        })
      )
    ).toThrow("Tailscale is not running");
    expect(() =>
      parseTailscaleStatus(
        JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "mac.example.", Online: false },
          TUN: true,
          TailscaleIPs: ["100.64.0.14"],
        })
      )
    ).toThrow("Tailscale node is not online");
  });

  test("rejects LAN, wildcard, and malformed addresses", () => {
    for (const ipv4 of ["192.168.1.115", "0.0.0.0", "100.128.0.1", "x"]) {
      expect(() =>
        parseTailscaleStatus(
          JSON.stringify({
            BackendState: "Running",
            Self: { Online: true },
            TUN: true,
            TailscaleIPs: [ipv4],
          })
        )
      ).toThrow("No valid Tailscale IPv4 address was reported");
    }
  });

  test("keeps the default server loopback-only", () => {
    expect(resolveWebUiServerEnvironment({})).toEqual({
      allowedHosts: undefined,
      host: "127.0.0.1",
      port: 46_327,
    });
  });

  test("accepts only an exact tailnet host and valid port override", () => {
    expect(
      resolveWebUiServerEnvironment({
        LOOP_WEBUI_ALLOWED_HOST: "sweetmac14.sweet.home",
        LOOP_WEBUI_HOST: "100.64.0.14",
        LOOP_WEBUI_PORT: "47000",
      })
    ).toEqual({
      allowedHosts: ["sweetmac14.sweet.home"],
      host: "100.64.0.14",
      port: 47_000,
    });

    expect(() =>
      resolveWebUiServerEnvironment({ LOOP_WEBUI_HOST: "0.0.0.0" })
    ).toThrow("Web UI host must be loopback or a Tailscale IPv4 address");
    expect(() =>
      resolveWebUiServerEnvironment({ LOOP_WEBUI_HOST: "192.168.1.115" })
    ).toThrow("Web UI host must be loopback or a Tailscale IPv4 address");
    expect(() =>
      resolveWebUiServerEnvironment({ LOOP_WEBUI_PORT: "70000" })
    ).toThrow("Web UI port must be an integer from 1024 through 65535");
    expect(() =>
      resolveWebUiServerEnvironment({ LOOP_WEBUI_ALLOWED_HOST: "bad host" })
    ).toThrow("Web UI allowed host must be a valid DNS name");
  });
});
