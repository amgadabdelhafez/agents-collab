import { describe, expect, test } from "bun:test";
import {
  assertListenPolicy,
  isLoopbackPublishedPort,
  parseServerEndpointUrl,
  parseServerOrigin,
  serverOriginFor,
} from "../../src/loop/orchestration-origin-policy";

describe("RA1 origin policy", () => {
  test("an https origin is accepted anywhere and normalised", () => {
    expect(parseServerOrigin("https://loop.home.lab")).toBe(
      "https://loop.home.lab"
    );
    expect(parseServerOrigin("https://Loop.Home.Lab:8443/")).toBe(
      "https://loop.home.lab:8443"
    );
  });

  test("http is accepted only on a loopback IP literal", () => {
    expect(parseServerOrigin("http://127.0.0.1:7321")).toBe(
      "http://127.0.0.1:7321"
    );
    expect(parseServerOrigin("http://[::1]:7321")).toBe("http://[::1]:7321");
    for (const origin of [
      "http://localhost:7321",
      "http://loop.home.lab",
      "http://100.64.0.7:7321",
      "http://0.0.0.0:7321",
      "http://127.0.0.2:7321",
    ]) {
      expect(() => parseServerOrigin(origin)).toThrow(
        "must be https, or http on 127.0.0.1 or [::1]"
      );
    }
  });

  test("an origin with credentials, a path, a query or a fragment, or another scheme, is refused", () => {
    for (const origin of [
      "https://user:pass@loop.home.lab",
      "https://loop.home.lab/api",
      "https://loop.home.lab?x=1",
      "https://loop.home.lab#x",
      "ws://127.0.0.1:7321",
      "not a url",
      42,
    ]) {
      expect(() => parseServerOrigin(origin)).toThrow();
    }
  });

  test("an endpoint URL may carry a path but never credentials, a query or a fragment", () => {
    expect(
      parseServerEndpointUrl("https://loop.home.lab/a2a/recipient").pathname
    ).toBe("/a2a/recipient");
    for (const url of [
      "https://u@loop.home.lab/a2a",
      "https://loop.home.lab/a2a?x",
      "https://loop.home.lab/a2a#x",
      "http://loop.home.lab/a2a",
    ]) {
      expect(() => parseServerEndpointUrl(url)).toThrow();
    }
  });

  test("a loopback listener always binds; beyond loopback needs an https origin and tokens", () => {
    for (const hostname of ["127.0.0.1", "::1", "localhost"]) {
      expect(assertListenPolicy({ hostname, tokens: false })).toBe(hostname);
    }
    expect(
      assertListenPolicy({
        hostname: "0.0.0.0",
        origin: "https://loop.home.lab",
        tokens: true,
      })
    ).toBe("0.0.0.0");
    expect(() =>
      assertListenPolicy({ hostname: "0.0.0.0", tokens: true })
    ).toThrow("needs an https origin and a tokens section");
    expect(() =>
      assertListenPolicy({
        hostname: "0.0.0.0",
        origin: "https://loop.home.lab",
        tokens: false,
      })
    ).toThrow("needs an https origin and a tokens section");
    expect(() =>
      assertListenPolicy({
        hostname: "100.64.0.7",
        origin: "http://127.0.0.1:7321",
        tokens: true,
      })
    ).toThrow("needs an https origin and a tokens section");
    expect(() =>
      assertListenPolicy({ hostname: "bad host!", tokens: true })
    ).toThrow("hostname is invalid");
  });

  test("the client origin is the configured one, else the loopback listener's", () => {
    expect(
      serverOriginFor({
        hostname: "0.0.0.0",
        origin: "https://loop.home.lab",
        port: 7321,
      })
    ).toBe("https://loop.home.lab");
    expect(serverOriginFor({ hostname: "127.0.0.1", port: 7321 })).toBe(
      "http://127.0.0.1:7321"
    );
    expect(serverOriginFor({ hostname: "::1", port: 7321 })).toBe(
      "http://[::1]:7321"
    );
  });

  test("a plaintext ledger port is published on a loopback IP literal only", () => {
    expect(isLoopbackPublishedPort("127.0.0.1:55432")).toBe(true);
    expect(isLoopbackPublishedPort("[::1]:55432")).toBe(true);
    for (const line of [
      "0.0.0.0:55432",
      "[::]:55432",
      "192.168.1.5:55432",
      "127.0.0.1",
      "127.0.0.1:port",
    ]) {
      expect(isLoopbackPublishedPort(line)).toBe(false);
    }
  });
});
