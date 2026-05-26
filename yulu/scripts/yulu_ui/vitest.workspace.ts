import { defineWorkspace } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "server",
      include: ["tests/**/*.test.ts"],
      exclude: ["tests/web/**", "node_modules/**"],
      environment: "node",
      pool: "forks",
    },
  },
  {
    extends: "./vitest.config.ts",
    plugins: [react()],
    test: {
      name: "web",
      include: ["tests/web/**/*.test.{ts,tsx}"],
      environment: "jsdom",
      setupFiles: ["tests/web/setup.ts"],
    },
  },
]);
