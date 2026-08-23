import { spawn, spawnSync, which } from "bun";

import {
  buildTailnetUrls,
  parseTailscaleStatus,
  resolveWebUiServerEnvironment,
} from "./tailscale";

const MACOS_APP_BINARY = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

function commandCandidates(): readonly string[] {
  const configured = process.env.TAILSCALE_BIN?.trim();
  if (configured) {
    return [configured];
  }
  return [...new Set([which("tailscale"), MACOS_APP_BINARY])].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
}

function readTailscaleStatus(): string {
  for (const candidate of commandCandidates()) {
    const result = spawnSync([candidate, "status", "--json"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if (result.exitCode === 0) {
      return result.stdout.toString();
    }
  }
  throw new Error(
    "Tailscale status is unavailable. Start Tailscale or set TAILSCALE_BIN to its CLI path."
  );
}

async function main(): Promise<void> {
  const binding = parseTailscaleStatus(readTailscaleStatus());
  const server = resolveWebUiServerEnvironment({
    LOOP_WEBUI_ALLOWED_HOST: binding.dnsName,
    LOOP_WEBUI_HOST: binding.ipv4,
    LOOP_WEBUI_PORT: process.env.LOOP_WEBUI_PORT,
  });
  const urls = buildTailnetUrls(binding, server.port);

  console.log("\nLoop Web UI will be private to this tailnet:");
  for (const url of urls) {
    console.log(`  ${url}`);
  }
  console.log("\nKeep this command running while you use the UI.\n");

  const child = spawn(["bun", "run", "web:dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOOP_WEBUI_ALLOWED_HOST: binding.dnsName ?? "",
      LOOP_WEBUI_HOST: binding.ipv4,
      LOOP_WEBUI_PORT: String(server.port),
    },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });

  const stopChild = () => child.kill("SIGTERM");
  process.once("SIGINT", stopChild);
  process.once("SIGTERM", stopChild);
  const exitCode = await child.exited;
  process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error(`[web:tailscale] ${message}`);
  process.exitCode = 1;
});
