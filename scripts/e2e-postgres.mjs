// npm run test:e2e:postgres → the browser demo script against PostgreSQL (embedded, data/e2e-pg)
// instead of a JSON file. Same as `E2E_STORE=pglite npx playwright test`, on any shell.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["playwright", "test", ...process.argv.slice(2)], { stdio: "inherit", shell: true, env: { ...process.env, E2E_STORE: "pglite" } });
process.exit(r.status ?? 1);
