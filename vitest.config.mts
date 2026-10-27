import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Two runs: every test on the JSON file store, and the business-logic tests again on PostgreSQL
// (embedded, in memory), so both stores are proven on every `npm test`.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    testTimeout: 30000,
    projects: [
      { extends: true, test: { name: "json", include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"], env: { STORE: "json" } } },
      { extends: true, test: { name: "postgres", include: ["tests/unit/**/*.test.ts"], env: { STORE: "pglite" } } },
    ],
  },
});
