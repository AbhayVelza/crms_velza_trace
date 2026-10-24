import { execSync } from "node:child_process";

// Fresh base seed in the e2e data file before the demo script runs.
export default function globalSetup() {
  execSync("npx tsx scripts/seed.ts", { stdio: "inherit", env: { ...process.env, VELZA_DB_PATH: "data/e2e-db.json" } });
}
