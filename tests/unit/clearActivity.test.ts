// `npm run clear-activity` safety (scripts/clearActivityGuard.ts): it shows the target and what it would delete,
// changes nothing without --force, never runs in production or on an ambiguous / missing target, and with --force
// writes a backup (never overwriting one) before clearing. Temporary folders and in-memory PostgreSQL only.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStore, storeKind } from "@/lib/store";
import { createPrintOrder } from "@/lib/services/printOrders";
import { ambiguousTarget, runClearActivity, type ClearActivityOptions } from "../../scripts/clearActivityGuard";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
let dir: string;
let backupDir: string;
let jsonFile: string | null;
const store = () => getStore();

const opts = (o: Partial<ClearActivityOptions> = {}): ClearActivityOptions => ({
  store,
  description: jsonFile ?? "PostgreSQL (embedded, in memory)",
  jsonFile,
  backupDir,
  force: false,
  production: false,
  env: {},
  log: () => undefined,
  ...o,
});
const backups = async () => (await fs.readdir(backupDir).catch(() => [] as string[])).filter((f) => f.includes("before-clear-activity"));

async function withActivity() {
  await store().reset(buildSampleSeed());
  const operator = (await store().users.list({ role: "OPERATOR" }))[0].id;
  await createPrintOrder(operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases: 2, trays: 0 }] });
  return store().snapshot();
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-clear-"));
  backupDir = path.join(dir, "backups");
  jsonFile = isJson ? path.join(dir, "db.json") : null;
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed()); // opens (and, for PostgreSQL, boots) the store outside the test timeout
});
beforeEach(async () => {
  await fs.rm(backupDir, { recursive: true, force: true });
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("clear-activity safety", () => {
  it("without --force it only reports what would be deleted and changes nothing", async () => {
    const before = await withActivity();
    const text = isJson ? await fs.readFile(jsonFile!, "utf8") : null;
    const lines: string[] = [];
    await expect(runClearActivity(opts({ log: (l) => lines.push(l) }))).rejects.toMatchObject({ code: "NOT_FORCED", message: expect.stringMatching(/2 lots.*Nothing was changed/) });
    expect(lines[0]).toMatch(/^Clear-activity target: /);
    expect((await store().snapshot()).lots).toHaveLength(before.lots.length);
    if (isJson) expect(await fs.readFile(jsonFile!, "utf8")).toBe(text);
    expect(await backups()).toEqual([]);
  });

  it("refuses in production, even with --force", async () => {
    const before = await withActivity();
    await expect(runClearActivity(opts({ force: true, production: true }))).rejects.toMatchObject({ code: "PRODUCTION" });
    expect((await store().snapshot()).lots).toHaveLength(before.lots.length);
  });

  it("refuses an ambiguous target", async () => {
    await withActivity();
    await expect(runClearActivity(opts({ force: true, env: { DATABASE_URL: "postgres://x/db", VELZA_DB_PATH: "a.json" } }))).rejects.toMatchObject({ code: "AMBIGUOUS_TARGET" });
    expect(ambiguousTarget({ STORE: "json", DATABASE_URL: "postgres://x/db" })).toMatch(/STORE=json/);
    expect(ambiguousTarget({ STORE: "postgres", DATABASE_URL: "postgres://x/db" })).toBeNull();
    expect(ambiguousTarget({})).toBeNull();
    expect((await store().snapshot()).lots.length).toBeGreaterThan(0);
  });

  it("with --force it writes a backup with the original data, then clears activity and keeps the setup", async () => {
    const before = await withActivity();
    const r = await runClearActivity(opts({ force: true, now: new Date("2026-11-04T10:00:00Z") }));
    expect(r.cleared).toMatchObject({ lots: before.lots.length, packs: before.packs.length, batches: before.batches.length });
    expect(path.basename(r.backup!)).toBe("db.backup-2026-11-04_10-00-00-before-clear-activity.json");
    const saved = JSON.parse(await fs.readFile(r.backup!, "utf8"));
    expect(saved.lots).toHaveLength(before.lots.length);
    const after = await store().snapshot();
    expect([after.lots, after.packs, after.batches, after.printOrders, after.movements, after.scans, after.reprints].map((x) => x.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(after.partners).toHaveLength(before.partners.length);
    expect(after.users).toHaveLength(before.users.length);
    expect(after.batchCodePool).toHaveLength(before.batchCodePool.length);
  });

  it("an existing backup is never overwritten: the run stops and nothing is changed", async () => {
    const before = await withActivity();
    const now = new Date("2026-11-04T11:00:00Z");
    await fs.mkdir(backupDir, { recursive: true });
    const clash = path.join(backupDir, "db.backup-2026-11-04_11-00-00-before-clear-activity.json");
    await fs.writeFile(clash, "keep me");
    await expect(runClearActivity(opts({ force: true, now }))).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    expect(await fs.readFile(clash, "utf8")).toBe("keep me");
    expect((await store().snapshot()).lots).toHaveLength(before.lots.length);
  });

  it("a backup folder that cannot be written leaves the data unchanged", async () => {
    const before = await withActivity();
    const blocker = path.join(dir, "not-a-folder");
    await fs.writeFile(blocker, "x");
    await expect(runClearActivity(opts({ force: true, backupDir: path.join(blocker, "sub") }))).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    expect((await store().snapshot()).lots).toHaveLength(before.lots.length);
  });

  it.runIf(isJson)("a JSON file that does not exist is refused and not created; a backup file is refused", async () => {
    const missing = path.join(dir, "missing.json");
    let opened = false;
    await expect(runClearActivity(opts({ force: true, jsonFile: missing, store: () => ((opened = true), store()) }))).rejects.toMatchObject({ code: "BAD_TARGET" });
    expect(opened).toBe(false);
    await expect(fs.stat(missing)).rejects.toThrow();
    await expect(runClearActivity(opts({ force: true, jsonFile: path.join(dir, "db.backup-x.json") }))).rejects.toMatchObject({ code: "BAD_TARGET" });
  });
});
