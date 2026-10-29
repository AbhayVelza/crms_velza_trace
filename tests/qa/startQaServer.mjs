// Start the app on the QA data file with sign-in ON (never data/db.json):
//
//   node tests/qa/startQaServer.mjs            # next dev on port 3300 (stop any other `next dev` in this folder first)
//   node tests/qa/startQaServer.mjs start      # next start on port 3300 (needs `npm run build` first)
//
// Creates data/qa-mh-2026-credentials.json with random test passwords on first use (git-ignored, like every
// data/*.json). A new QA data file gets Velza Admin AD0001 and Velza HQ HQ0001 with those passwords; the
// 18 QA partners get `partnerPassword` when tests/qa/qaRun.ts registers them. Passwords are never printed.

import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataFile = path.resolve(process.env.QA_DB_PATH ?? "data/qa-mh-2026.json");
const credsFile = path.resolve(process.env.QA_CREDENTIALS ?? "data/qa-mh-2026-credentials.json");
const port = process.env.QA_PORT ?? "3300";
const mode = process.argv[2] === "start" ? "start" : "dev";

if (path.basename(dataFile) === "db.json") throw new Error("Refusing to run the QA server on data/db.json");

function password() {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const chars = [letters[randomInt(letters.length)], digits[randomInt(digits.length)], ...Array.from({ length: 14 }, () => all[randomInt(all.length)])];
  return chars.sort(() => randomInt(3) - 1).join("");
}

if (!existsSync(credsFile)) {
  writeFileSync(credsFile, JSON.stringify({ adminPassword: password(), hqPassword: password(), partnerPassword: password() }, null, 2) + "\n");
  console.log(`Created ${path.relative(root, credsFile)} (test passwords; git-ignored)`);
}
const creds = JSON.parse(readFileSync(credsFile, "utf8"));

const env = {
  ...process.env,
  STORE: "json",
  VELZA_DB_PATH: dataFile,
  SIGN_IN: "on",
  VELZA_ADMIN_PASSWORD: creds.adminPassword,
  VELZA_HQ_PASSWORD: creds.hqPassword,
};
console.log(`QA server: next ${mode} on http://localhost:${port}, data ${path.relative(root, dataFile)}, sign-in ON`);
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", mode, "-p", port], { env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
// The first start on an empty data file prints the staff passwords once; keep them out of the console.
const scrub = (s) => s.replace(/\b(password:?\s+)\S+/gi, "$1[hidden — see the credentials file]");
child.stdout.on("data", (d) => process.stdout.write(scrub(String(d))));
child.stderr.on("data", (d) => process.stderr.write(scrub(String(d))));
child.on("exit", (code) => process.exit(code ?? 0));
