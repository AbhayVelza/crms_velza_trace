// `npm run seed` safety (src/lib/store/seedGuard.ts): an empty target is seeded; real data is refused unless
// --force, which writes a backup first (never overwriting one); production data is never replaced.
// Runs on the JSON file store and on PostgreSQL (embedded), in temporary folders only.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getStore, storeKind } from "@/lib/store";
import { buildBaseSeed } from "@/lib/store/seedData";
import { runSeed, type SeedOptions } from "@/lib/store/seedGuard";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

const isJson = storeKind() === "json";
let dir: string;
let backupDir: string;
let jsonFile: string | null;
const store = () => getStore();
const passwords = { admin: "Envpass123", hq: "Envpass456" };

const opts = (o: Partial<SeedOptions> = {}): SeedOptions => ({
  store: store(),
  description: jsonFile ?? "PostgreSQL (embedded, in memory)",
  jsonFile,
  backupDir,
  force: false,
  production: false,
  passwords,
  generated: { admin: false, hq: false },
  log: () => undefined,
  ...o,
});
const backups = async () => (await fs.readdir(backupDir).catch(() => [] as string[])).filter((f) => f.includes("backup"));

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-seed-"));
  backupDir = path.join(dir, "backups");
  jsonFile = isJson ? path.join(dir, "db.json") : null;
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
});
beforeEach(async () => {
  await fs.rm(backupDir, { recursive: true, force: true });
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("seed safety", () => {
  it.runIf(isJson)("a JSON file that does not exist yet is seeded, without a backup", async () => {
    await fs.rm(path.join(dir, "db.json"), { force: true });
    const r = await runSeed(opts());
    expect(r).toEqual({ replaced: {}, backup: null });
    expect((await store().snapshot()).users.map((u) => u.id).sort()).toEqual(["AD0001", "HQ0001"]);
  });

  it("a clean start (staff sign-ins and reference data only) is reseeded without --force or backup", async () => {
    await store().reset(buildBaseSeed(passwords));
    const r = await runSeed(opts());
    expect(r.backup).toBeNull();
    expect(await backups()).toEqual([]);
  });

  it("real data is refused without --force: nothing changes, no backup", async () => {
    await store().reset(buildSampleSeed());
    const before = await store().snapshot();
    await expect(runSeed(opts())).rejects.toMatchObject({ code: "NOT_EMPTY", message: expect.stringMatching(/Refusing to seed: the target holds \d+ partners.*--force/) });
    expect((await store().snapshot()).partners).toEqual(before.partners);
    expect(await backups()).toEqual([]);
  });

  it("--force writes a complete backup first, then the clean start", async () => {
    await store().reset(buildSampleSeed());
    const before = await store().snapshot();
    const lines: string[] = [];
    const r = await runSeed(opts({ force: true, log: (l) => lines.push(l) }));
    expect(r.backup).toMatch(/db\.backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-before-seed\.json$/);
    const saved = JSON.parse(await fs.readFile(r.backup!, "utf8"));
    expect(saved.partners).toEqual(before.partners);
    expect(saved.users.length).toBe(before.users.length);
    expect((await store().snapshot()).partners).toEqual([]);
    expect(r.replaced.partners).toBe(before.partners.length);
    // The log names the target and the backup, and never prints passwords taken from the environment.
    expect(lines[0]).toBe(`Seed target: ${opts().description}`);
    expect(lines.join("\n")).toContain(r.backup!);
    expect(lines.join("\n")).not.toMatch(/Envpass/);
  });

  it("never overwrites an existing backup: a clash stops the seed and keeps the data", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    await store().reset(buildSampleSeed());
    await runSeed(opts({ force: true, now }));
    await store().reset(buildSampleSeed());
    const before = await store().snapshot();
    const first = (await backups())[0];
    const firstText = await fs.readFile(path.join(backupDir, first), "utf8");
    await expect(runSeed(opts({ force: true, now }))).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    expect((await store().snapshot()).partners).toEqual(before.partners);
    expect(await fs.readFile(path.join(backupDir, first), "utf8")).toBe(firstText);
  });

  it("a backup folder that cannot be written stops the seed and keeps the data", async () => {
    const blocker = path.join(dir, "not-a-folder");
    await fs.writeFile(blocker, "x");
    await store().reset(buildSampleSeed());
    const before = await store().snapshot();
    await expect(runSeed(opts({ force: true, backupDir: path.join(blocker, "backups") }))).rejects.toMatchObject({ code: "BACKUP_FAILED" });
    expect((await store().snapshot()).partners).toEqual(before.partners);
  });

  it("production: data is never replaced, even with --force; an empty target can still be set up", async () => {
    await store().reset(buildSampleSeed());
    const before = await store().snapshot();
    await expect(runSeed(opts({ force: true, production: true }))).rejects.toMatchObject({ code: "PRODUCTION" });
    expect((await store().snapshot()).partners).toEqual(before.partners);
    expect(await backups()).toEqual([]);
    await store().reset(buildBaseSeed(passwords));
    await expect(runSeed(opts({ production: true }))).resolves.toMatchObject({ backup: null });
  });

  it("generated passwords are shown once; environment passwords never", async () => {
    await store().reset(buildBaseSeed(passwords));
    const lines: string[] = [];
    await runSeed(opts({ generated: { admin: true, hq: false }, log: (l) => lines.push(l) }));
    const text = lines.join("\n");
    expect(text).toContain("password Envpass123"); // treated as generated here
    expect(text).toContain("password from VELZA_HQ_PASSWORD");
    expect(text).not.toContain("Envpass456");
  });

  it.runIf(isJson)("JSON targets must be a plain .json file in an existing folder, and not a backup", async () => {
    await fs.mkdir(path.join(dir, "folder.json"), { recursive: true });
    for (const [file, why] of [
      [path.join(dir, "db.txt"), /must end in \.json/],
      [path.join(dir, "db.backup-2026.json"), /looks like a backup/],
      [path.join(dir, "missing", "db.json"), /does not exist/],
      [path.join(dir, "folder.json"), /not a plain file/],
    ] as const) {
      await expect(runSeed(opts({ jsonFile: file }))).rejects.toMatchObject({ code: "BAD_TARGET", message: expect.stringMatching(why) });
    }
  });
});
