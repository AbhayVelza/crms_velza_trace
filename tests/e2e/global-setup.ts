import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { E2E_PG_DIR, E2E_STORE_ENV } from "../../playwright.config";

// Fresh sample network in the e2e store (JSON file, or embedded PostgreSQL) before the demo script runs.
export default function globalSetup() {
  if (E2E_STORE_ENV.STORE === "pglite") rmSync(E2E_PG_DIR, { recursive: true, force: true });
  execSync("npx tsx tests/e2e/seed-sample.ts", { stdio: "inherit", env: { ...process.env, ...E2E_STORE_ENV } });
}
