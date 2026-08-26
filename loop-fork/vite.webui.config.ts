import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { exactHostGuardPlugin } from "./src/webui/server/exact-host-guard.ts";
import { loopRegistryLiveDataPlugin } from "./src/webui/server/harvto-live-data.ts";
import { resolveWebUiServerEnvironment } from "./src/webui/tailscale.ts";

const network = resolveWebUiServerEnvironment(process.env);
const expectedHosts = [network.host, ...(network.allowedHosts ?? [])].map(
  (host) => `${host}:${network.port}`
);

export default defineConfig({
  root: "src/webui",
  plugins: [
    exactHostGuardPlugin(expectedHosts),
    loopRegistryLiveDataPlugin({ expectedHosts }),
    react(),
  ],
  server: {
    allowedHosts: network.allowedHosts,
    hmr: false,
    host: network.host,
    port: network.port,
    strictPort: true,
  },
  preview: {
    allowedHosts: network.allowedHosts,
    host: network.host,
    port: network.port,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/webui",
    emptyOutDir: true,
    sourcemap: true,
  },
});
