import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // node:sqlite is not handled by vite's resolver in some vitest versions
    alias: { "node:sqlite": "node:sqlite" },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    server: {
      deps: {
        inline: [/@rio\//],
      },
    },
  },
});
