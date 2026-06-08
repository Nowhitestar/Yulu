import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  test: {
    testTimeout: 5_000,
    projects: [
      {
        test: {
          name: "server",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/web/**", "node_modules/**"],
          environment: "node",
          pool: "forks",
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          include: ["tests/web/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["tests/web/setup.ts"],
        },
      },
    ],
  },
});
