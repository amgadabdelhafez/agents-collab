import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { harvtoLiveDataPlugin } from "./src/webui/server/harvto-live-data.ts";

export default defineConfig({
  root: "src/webui",
  plugins: [harvtoLiveDataPlugin(), react()],
  server: {
    hmr: false,
    host: "127.0.0.1",
    port: 46_327,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 46_327,
    strictPort: true,
  },
  build: {
    outDir: "../../dist/webui",
    emptyOutDir: true,
    sourcemap: true,
  },
});
