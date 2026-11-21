// Schema v10 keeps what each container carried as rows (container_items) next to containers.lot_codes. The Container
// type and the services are unchanged: triggers on containers make container_items equal to lot_codes on every container
// write (create, load, unload, cancel, dispatch, receive, clear, reset). The JSON store keeps only its array.
// Runs on the JSON file store and on PostgreSQL (embedded).

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { SqlStore } from "@/lib/store/sql/sqlStore";
import { cancelContainer, clearContainer, createContainer, dispatchContainer, loadContainer, unloadContainer } from "@/lib/services/containers";
import { receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];
const sql = () => (store() instanceof SqlStore ? (store() as SqlStore) : null);

async function user(role: Role) {
  return (await store().users.list({ role }))[0].id;
}
async function verifyLot(lotCode: string) {
  const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  for (const [i, code] of packs.entries()) await verify(ids.qc, { action: "scanPack", lotCode, code, scanned: packs.slice(0, i) });
  await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}

/** container_items as "container|lot" pairs, and the same pairs from every container's lot_codes: always equal. */
async function expectItemsInSync() {
  const fromArrays = (await store().containers.list()).flatMap((c) => c.lotCodes.map((l) => `${c.id}|${l}`)).sort();
  const s = sql();
  if (!s) return fromArrays; // JSON store: the array is the only record
  const d = await s.driver();
  const rows = await d.query<{ container_id: string; lot_code: string }>(`SELECT container_id, lot_code FROM container_items`);
  expect(rows.map((r) => `${r.container_id}|${r.lot_code}`).sort()).toEqual(fromArrays);
  return fromArrays;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-items-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.op = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.VW = (await store().partners.list({ type: "WAREHOUSE" }))[0].id;
  const created = await createPrintOrder(ids.op, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 3, trays: 0 }] });
  if (created.preview) throw new Error("expected a created order");
  await markPrinted(ids.op, created.printOrder.id);
  lots = created.printOrder.lotCodes;
  for (const code of lots) await verifyLot(code);
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("container_items follows containers.lot_codes", () => {
  let a: string;
  let b: string;

  it("create, load and unload", async () => {
    a = (await createContainer(ids.op, { code: "ITEM0000001" })).container.id;
    expect(await expectItemsInSync()).toEqual([]);
    for (const l of [lots[0], lots[1]]) expect(await loadContainer(ids.op, a, { code: l })).toMatchObject({ ok: true });
    expect(await expectItemsInSync()).toEqual([`${a}|${lots[0]}`, `${a}|${lots[1]}`].sort());
    expect(await unloadContainer(ids.op, a, { code: lots[1] })).toMatchObject({ ok: true });
    expect(await expectItemsInSync()).toEqual([`${a}|${lots[0]}`]);
    expect(await loadContainer(ids.op, a, { code: lots[2] })).toMatchObject({ ok: true });
    expect(await expectItemsInSync()).toEqual([`${a}|${lots[0]}`, `${a}|${lots[2]}`].sort());
  });

  it("a second container, then cancelled: its rows go with it", async () => {
    b = (await createContainer(ids.op, { code: "ITEM0000002" })).container.id;
    expect(await loadContainer(ids.op, b, { code: lots[1] })).toMatchObject({ ok: true });
    expect(await loadContainer(ids.op, b, { code: lots[0] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" }); // already in A
    expect(await expectItemsInSync()).toContain(`${b}|${lots[1]}`);
    expect(await cancelContainer(ids.op, b)).toMatchObject({ ok: true });
    expect(await store().containers.get(b)).toBeNull();
    expect(await expectItemsInSync()).toEqual([`${a}|${lots[0]}`, `${a}|${lots[2]}`].sort());
  });

  it("dispatch, receive at Customs and clear change the status only; the rows stay", async () => {
    await dispatchContainer(ids.op, a, { toPartnerId: ids.VW, invoice: "INV-ITEMS" });
    expect(await expectItemsInSync()).toEqual([`${a}|${lots[0]}`, `${a}|${lots[2]}`].sort());
    expect((await store().latestContainerWithLot(ids.VW, lots[0], ["IN_TRANSIT"]))?.id).toBe(a);
    expect(await receive(ids.vw, { code: "ITEM0000001" })).toMatchObject({ ok: true });
    expect(await expectItemsInSync()).toHaveLength(2);
    expect((await store().latestContainerWithLot(ids.VW, lots[2], ["RECEIVED"]))?.id).toBe(a);
    expect(await clearContainer(ids.vw, a, { billOfEntry: "BE-1" })).toMatchObject({ ok: true, cleared: 2 });
    expect(await expectItemsInSync()).toHaveLength(2);
    // Which container carried a lot: found through container_items on PostgreSQL, through the array on JSON.
    expect((await store().latestContainerWithLot(ids.VW, lots[0], ["CLEARED"]))?.id).toBe(a);
    expect(await store().latestContainerWithLot(ids.VW, lots[1], ["IN_TRANSIT", "RECEIVED", "CLEARED"])).toBeNull(); // only in the cancelled one
  });

  it("who loaded and when: the operator who opened the container (PostgreSQL)", async () => {
    const s = sql();
    if (!s) return;
    const d = await s.driver();
    const rows = await d.query<{ loaded_by: string | null; loaded: boolean }>(`SELECT loaded_by, loaded_at IS NOT NULL AS loaded FROM container_items`);
    expect(rows).toEqual([
      { loaded_by: ids.op, loaded: true },
      { loaded_by: ids.op, loaded: true },
    ]);
  });

  it("snapshot → reset keeps them equal (the reset rebuilds container_items from lot_codes)", async () => {
    const before = await expectItemsInSync();
    await store().reset(await store().snapshot());
    expect(await expectItemsInSync()).toEqual(before);
  });
});
