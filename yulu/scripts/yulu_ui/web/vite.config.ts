import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/trpc":    "http://127.0.0.1:7777",
      "/files":   "http://127.0.0.1:7777",
      "/healthz": "http://127.0.0.1:7777",
      "/ws":      { target: "ws://127.0.0.1:7777", ws: true, rewriteWsOrigin: true },
    },
  },
});
