import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The *-sqlite projects run the same suites with `convex-test` replaced by the
// local-mode SQLite backend: one behavioral suite, both backends.
const sqliteShim = { "convex-test": fileURLToPath(new URL("./packages/local-backend/test/convex-test-shim.ts", import.meta.url)) };

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
      {
        resolve: { alias: sqliteShim },
        test: {
          name: "convex-sqlite",
          include: ["convex/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias: sqliteShim },
        test: {
          name: "connector-sqlite",
          include: ["packages/connector/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "local-backend",
          include: ["packages/local-backend/test/**/*.test.ts", "packages/service/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
    ],
  },
});
