// npm test / npm run test:watch → Vitest, started from the project folder with an uppercase drive letter.
// On Windows a shell opened in "c:\..." (Git Bash, some VS Code terminals) makes Vitest load its runner
// under two path spellings ("c:" and "C:") and every file fails with "Vitest failed to find the runner".
// Elsewhere this simply runs Vitest with the same arguments.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform === "win32") root = root[0].toUpperCase() + root.slice(1);

const r = spawnSync(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
});
process.exit(r.status ?? 1);
