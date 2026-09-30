import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "convex",
          include: ["convex/**/*.test.ts"],
          environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } },
        },
      },
      {
        test: {
          name: "connector",
          include: ["packages/connector/test/**/*.test.ts"],
          environment: "node",
          server: { deps: { inline: ["convex-test"] } },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
