import { defineConfig } from "@playwright/test";

// End-to-end demo script (spec 9.1) against a production build on port 3100 with its own data file,
// so it never touches data/db.json or a running `npm run dev`.
// Uses the installed Microsoft Edge by default (no browser download); set PW_CHANNEL=chrome or "" to change.

const PORT = 3100;
export const E2E_DB = "data/e2e-db.json";

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
    url: `http://localhost:${PORT}/api/bootstrap`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { VELZA_DB_PATH: E2E_DB },
  },
});
