const DEFAULT_WEB_UI_PORT = 46_327;
const LOOPBACK_HOST = "127.0.0.1";
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4_OCTET_PATTERN = /^(?:0|[1-9]\d{0,2})$/u;
const PORT_PATTERN = /^\d+$/u;
const TRAILING_DOT_PATTERN = /\.$/u;

export interface TailnetBinding {
  readonly dnsName?: string;
  readonly ipv4: string;
}

export interface WebUiServerEnvironment {
  readonly allowedHosts: string[] | undefined;
  readonly host: string;
  readonly port: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIpv4(value: string): readonly number[] | undefined {
  const octets = value.split(".");
  if (octets.length !== 4) {
    return undefined;
  }
  const parsed = octets.map((octet) => {
    if (!IPV4_OCTET_PATTERN.test(octet)) {
      return Number.NaN;
    }
    return Number(octet);
  });
  return parsed.every((octet) => Number.isInteger(octet) && octet <= 255)
    ? parsed
    : undefined;
}

function isTailscaleIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  return Boolean(
    octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127
  );
}

function normalizeDnsName(value: unknown): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Tailscale DNS name was malformed");
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(TRAILING_DOT_PATTERN, "");
  const labels = normalized.split(".");
  if (
    normalized.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !DNS_LABEL_PATTERN.test(label))
  ) {
    throw new Error("Tailscale DNS name was malformed");
  }
  return normalized;
}

export function parseTailscaleStatus(rawStatus: string): TailnetBinding {
  let status: unknown;
  try {
    status = JSON.parse(rawStatus);
  } catch {
    throw new Error("Tailscale status was not valid JSON");
  }
  if (!isRecord(status)) {
    throw new Error("Tailscale status was malformed");
  }
  if (status.BackendState !== "Running" || status.TUN !== true) {
    throw new Error("Tailscale is not running");
  }
  if (!isRecord(status.Self) || status.Self.Online !== true) {
    throw new Error("Tailscale node is not online");
  }
  const addresses = status.TailscaleIPs;
  const ipv4 = Array.isArray(addresses)
    ? addresses.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && isTailscaleIpv4(candidate)
      )
    : undefined;
  if (!ipv4) {
    throw new Error("No valid Tailscale IPv4 address was reported");
  }
  const dnsName = normalizeDnsName(status.Self.DNSName);
  return dnsName ? { dnsName, ipv4 } : { ipv4 };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_WEB_UI_PORT;
  }
  if (!PORT_PATTERN.test(value)) {
    throw new Error("Web UI port must be an integer from 1024 through 65535");
  }
  const port = Number(value);
  if (!(Number.isInteger(port) && port >= 1024 && port <= 65_535)) {
    throw new Error("Web UI port must be an integer from 1024 through 65535");
  }
  return port;
}

export function resolveWebUiServerEnvironment(
  environment: Environment
): WebUiServerEnvironment {
  const host = environment.LOOP_WEBUI_HOST?.trim() || LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST && !isTailscaleIpv4(host)) {
    throw new Error("Web UI host must be loopback or a Tailscale IPv4 address");
  }

  const allowedHostValue = environment.LOOP_WEBUI_ALLOWED_HOST?.trim();
  let allowedHosts: string[] | undefined;
  if (allowedHostValue) {
    let allowedHost: string | undefined;
    try {
      allowedHost = normalizeDnsName(allowedHostValue);
    } catch {
      throw new Error("Web UI allowed host must be a valid DNS name");
    }
    if (!allowedHost) {
      throw new Error("Web UI allowed host must be a valid DNS name");
    }
    allowedHosts = [allowedHost];
  }

  return {
    allowedHosts,
    host,
    port: parsePort(environment.LOOP_WEBUI_PORT),
  };
}

export function buildTailnetUrls(
  binding: TailnetBinding,
  port: number
): readonly string[] {
  const urls = [`http://${binding.ipv4}:${port}/`];
  if (binding.dnsName) {
    urls.push(`http://${binding.dnsName}:${port}/`);
  }
  return urls;
}
