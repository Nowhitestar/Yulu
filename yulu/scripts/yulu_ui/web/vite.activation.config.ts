import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 4174,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/api/ui-token": "http://127.0.0.1:7778",
      "/trpc": "http://127.0.0.1:7778",
      "/files": "http://127.0.0.1:7778",
      "/healthz": "http://127.0.0.1:7778",
      "/ws": { target: "ws://127.0.0.1:7778", ws: true, rewriteWsOrigin: true },
    },
  },
});
