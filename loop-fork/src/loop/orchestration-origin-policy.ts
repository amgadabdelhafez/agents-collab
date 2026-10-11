/**
 * RA1: the one transport policy the orchestration server and its clients
 * share, replacing four separate loopback-only checks.
 *
 * - Plaintext only on loopback: an `http:` origin, and a ledger port
 *   published by `a2a-v2 init`, must be 127.0.0.1 or [::1] (IP literals, so
 *   no resolver or hosts file can move them).
 * - Anything beyond loopback is a configured `https:` origin: TLS is
 *   terminated in front of the server (Caddy), never skipped.
 * - A server that listens beyond loopback must also carry audience-bound
 *   session tokens (a `tokens` section). Nothing here opens a listener: the
 *   server still binds exactly the configured hostname.
 * - A URL that carries credentials, a query or a fragment is refused, so a
 *   bearer token is only ever attached to the configured server itself.
 */

const LOOPBACK_LITERALS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const LOOPBACK_LISTEN_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
]);
const DNS_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const LISTEN_HOST_RE = new RegExp(
  `^(?:${DNS_LABEL}(?:\\.${DNS_LABEL})*|[0-9A-Fa-f:.]{2,45})$`
);
const MAX_URL_LENGTH = 2048;
const PORT_RE = /^\d{1,5}$/;

/** An IP literal that is loopback: 127.0.0.1, ::1 or [::1]. */
export const isLoopbackLiteral = (host: string): boolean =>
  LOOPBACK_LITERALS.has(host);

/** A listen hostname that only binds loopback (localhost included). */
export const isLoopbackListenHost = (host: string): boolean =>
  LOOPBACK_LISTEN_HOSTS.has(host);

const parseUrl = (value: unknown, label: string): URL => {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new Error(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} is invalid`);
  }
  return url;
};

const assertTransport = (url: URL, label: string): void => {
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && isLoopbackLiteral(url.hostname)) {
    return;
  }
  throw new Error(`${label} must be https, or http on 127.0.0.1 or [::1]`);
};

/**
 * A configured server origin (`scheme://host[:port]`, no path): https, or
 * http only on a loopback IP literal. Returns the normalised origin.
 */
export const parseServerOrigin = (value: unknown, label = "origin"): string => {
  const url = parseUrl(value, label);
  if (url.pathname !== "/") {
    throw new Error(`${label} is invalid`);
  }
  assertTransport(url, label);
  return url.origin;
};

/**
 * A full endpoint URL on a server (a route path is allowed): https, or http
 * only on a loopback IP literal; never credentials, a query or a fragment.
 */
export const parseServerEndpointUrl = (
  value: unknown,
  label = "endpoint"
): URL => {
  const url = parseUrl(value, label);
  assertTransport(url, label);
  return url;
};

/**
 * The listen hostname under this policy. Loopback always binds. Anything
 * else (a tailnet address, a pod's 0.0.0.0) needs an https origin in front
 * of it and audience-bound tokens; otherwise it is refused at parse time.
 */
export const assertListenPolicy = (input: {
  hostname: unknown;
  origin?: string;
  tokens: boolean;
}): string => {
  const hostname = input.hostname;
  if (typeof hostname !== "string" || !LISTEN_HOST_RE.test(hostname)) {
    throw new Error("orchestration hostname is invalid");
  }
  if (isLoopbackListenHost(hostname)) {
    return hostname;
  }
  if (!(input.origin?.startsWith("https:") && input.tokens)) {
    throw new Error(
      "orchestration hostname is invalid: a listener beyond loopback needs an https origin and a tokens section"
    );
  }
  return hostname;
};

/** The origin clients use: the configured one, else the loopback listener. */
export const serverOriginFor = (input: {
  hostname: string;
  origin?: string;
  port: number;
}): string => {
  if (input.origin) {
    return input.origin;
  }
  const host = input.hostname.includes(":")
    ? `[${input.hostname}]`
    : input.hostname;
  return `http://${host}:${input.port}`;
};

/**
 * A `docker port` line for a plaintext ledger port: published on a loopback
 * IP literal only (`127.0.0.1:<port>` or `[::1]:<port>`).
 */
export const isLoopbackPublishedPort = (line: string): boolean => {
  const separator = line.lastIndexOf(":");
  if (separator <= 0 || !PORT_RE.test(line.slice(separator + 1))) {
    return false;
  }
  return isLoopbackLiteral(line.slice(0, separator));
};
