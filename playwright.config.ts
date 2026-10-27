import { defineConfig } from "@playwright/test";

// End-to-end demo script (spec 9.1) against a production build on port 3100 with its own data,
// so it never touches data/db.json or a running `npm run dev`.
// E2E_STORE=pglite runs the same script against PostgreSQL (embedded, in data/e2e-pg) instead of a JSON file.
// Uses the installed Microsoft Edge by default (no browser download); set PW_CHANNEL=chrome or "" to change.

const PORT = 3100;
export const E2E_DB = "data/e2e-db.json";
export const E2E_PG_DIR = "data/e2e-pg";
export const E2E_STORE_ENV: Record<string, string> =
  process.env.E2E_STORE === "pglite" ? { STORE: "pglite", PGLITE_DIR: E2E_PG_DIR } : { STORE: "json", VELZA_DB_PATH: E2E_DB };
// The demo script signs in with passwords, so sign-in is on whatever .env.local says.
const E2E_SERVER_ENV = { ...E2E_STORE_ENV, SIGN_IN: "on" };

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 3, // sharp sticker screenshots for barcode decoding
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    // The sign-in page doesn't open the store, so the data can be seeded before the server first touches it.
    url: `http://localhost:${PORT}/login`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: E2E_SERVER_ENV,
  },
});
