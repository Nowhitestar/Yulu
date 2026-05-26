import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 5_000,
    pool: "forks",         // better-sqlite3 + worker isolation
  },
});
