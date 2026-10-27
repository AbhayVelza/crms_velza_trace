// A quarantined lot either ends as VOID, or a sticker is reprinted (with a reason) and QC verifies it again → PACKED.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { dispatch } from "@/lib/services/movement";
import { reprint, voidLot } from "@/lib/services/operator";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
let lots: string[] = [];
const packsOf = async (lotCode: string) => (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
const statusOf = async (lotCode: string) => (await store().lots.findOne({ lotCode }))?.status;

/** QC scans every pack and confirms. */
async function verifyAll(lotCode: string) {
  const packs = await packsOf(lotCode);
  await verify(ids.qc, { action: "scanLot", code: lotCode });
  return verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-quarantine-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  for (const [k, role] of [["operator", "OPERATOR"], ["qc", "QC"]] as [string, Role][]) {
    ids[k] = (await store().users.list({ role }))[0].id;
  }
  ids.SS1 = (await store().partners.list()).find((p) => p.name.startsWith("SS-1"))!.id;
  const created = await createPrintOrder(ids.operator, { batches: [{ flavour: "OR", mfgDate: "2026-10-26", expiryDate: "2027-07-26", cases: 2, trays: 0 }] });
  if (created.preview) throw new Error("expected order");
  await markPrinted(ids.operator, created.printOrder.id);
  lots = created.printOrder.lotCodes;
  // both fail QC: a pack sticker is missing
  for (const lotCode of lots) {
    const packs = await packsOf(lotCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    expect(await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs.slice(0, 3) })).toMatchObject({ code: "QUARANTINED" });
  }
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("quarantined lot", () => {
  it("stays blocked while quarantined: no QC, no dispatch", async () => {
    expect(await statusOf(lots[0])).toBe("QUARANTINED");
    expect(await verify(ids.qc, { action: "scanLot", code: lots[0] })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "INV-1", code: lots[0] })).toMatchObject({ ok: false });
  });

  it("reprint with a reason → back to PRINTED for QC; QC verifies → PACKED, dispatchable", async () => {
    const missing = (await packsOf(lots[0]))[3];
    await expect(reprint(ids.operator, { code: missing, reason: " " })).rejects.toThrow(/reason/);
    const r = await reprint(ids.operator, { code: missing, reason: "Pack sticker missing, reprinted" });
    expect(r.message).toMatch(/out of quarantine .* QC must verify it again/);
    expect(await statusOf(lots[0])).toBe("PRINTED");
    expect((await store().packs.list({ lotCode: lots[0] })).every((p) => p.status === "PRINTED")).toBe(true);
    // not sellable until QC passes it
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "INV-1", code: lots[0] })).toMatchObject({ ok: false });

    expect(await verifyAll(lots[0])).toMatchObject({ ok: true });
    expect(await statusOf(lots[0])).toBe("PACKED");
    expect(await dispatch(ids.operator, { action: "check", toPartnerId: ids.SS1, invoice: "INV-1", code: lots[0] })).toMatchObject({ ok: true });

    const history = (await store().movements.list()).filter((m) => m.itemCode.startsWith(lots[0])).map((m) => [m.type, m.toStatus]);
    expect(history.slice(-3)).toEqual([["QUARANTINED", "QUARANTINED"], ["REPRINTED", "PRINTED"], ["VERIFIED", "PACKED"]]);
  });

  it("void → VOID for good: no reprint, no QC", async () => {
    expect(await voidLot(ids.operator, { lotCode: lots[1], reason: "Damaged on the line" })).toMatchObject({ ok: true });
    expect(await statusOf(lots[1])).toBe("VOID");
    expect((await store().packs.list({ lotCode: lots[1] })).every((p) => p.status === "VOID")).toBe(true);
    await expect(reprint(ids.operator, { code: lots[1], reason: "try again" })).rejects.toMatchObject({ code: "WRONG_STATUS" });
    expect(await verify(ids.qc, { action: "scanLot", code: lots[1] })).toMatchObject({ ok: false, code: "BLOCKED_CODE" });
  });
});
