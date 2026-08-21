import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/webui",
  plugins: [react()],
  server: {
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
