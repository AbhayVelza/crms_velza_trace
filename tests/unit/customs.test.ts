// Customs (16 Nov 2026): the plant ships containers to Customs (partner type WAREHOUSE, VW…); whatever is scanned in
// there — a container number or a case/tray — is held AT_CUSTOMS until the Velza person at Customs clears the
// container; cleared stock (AT_WAREHOUSE) goes only to Super Stockists.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ItemStatus, Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { clearContainer, createContainer, dispatchContainer, getContainer, loadContainer } from "@/lib/services/containers";
import { updateSettings } from "@/lib/services/admin";
import { reportDamaged } from "@/lib/services/damage";
import { dispatch, receive } from "@/lib/services/movement";
import { recall } from "@/lib/services/trace";
import { photoOf } from "../fixtures/damagePhoto";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { takeBack } from "@/lib/services/returns";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();
const FIELD = "VF0001";
let seq = 0;

/** Cases printed and passed by QC (PACKED at the plant). */
async function packedLots(cases: number) {
  const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays: 0 }] });
  if (r.preview) throw new Error("expected an order");
  await markPrinted(ids.operator, r.printOrder.id);
  for (const lotCode of r.printOrder.lotCodes) {
    const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  return r.printOrder.lotCodes;
}

/** A container loaded with these lots and dispatched to Customs; returns its id and number. */
async function containerOnTheWay(lots: string[]) {
  const code = `TCSU${String(++seq).padStart(7, "0")}`;
  const { container } = await createContainer(ids.operator, { code });
  for (const lot of lots) await loadContainer(ids.operator, container.id, { code: lot });
  await dispatchContainer(ids.operator, container.id, { toPartnerId: ids.VW, invoice: `INV-${code}` });
  return { id: container.id, code };
}

const lotStatus = async (lotCode: string) => (await store().lots.findOne({ lotCode }))!.status;
const packStatuses = async (lotCode: string) => [...new Set((await store().packs.list({ lotCode })).map((p) => p.status))];

/**
 * Puts a sealed lot into a state directly, for situations the current flow can no longer create. Its packs follow it
 * (Option C): only the lot row is written.
 */
async function place(lotCode: string, patch: { status: ItemStatus; locationId: string; inTransitToId?: string | null }) {
  const lot = (await store().lots.findOne({ lotCode }))!;
  await store().lots.update(lot.id, { inTransitToId: null, ...patch });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-customs-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  process.env.VELZA_UPLOAD_DIR = path.join(dir, "uploads");
  await store().reset(buildSampleSeed());
  const [users, partners] = await Promise.all([store().users.list(), store().partners.list()]);
  const user = (role: Role, prefix?: string) => users.find((u) => u.role === role && (!prefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(prefix)))!.id;
  Object.assign(ids, { operator: user("OPERATOR"), qc: user("QC"), vw: user("WAREHOUSE"), ss1: user("SS", "SS-1"), hq: user("TRACE_OWNER"), admin: user("ADMIN") });
  for (const [k, prefix] of [["VW", "VW-1"], ["SS1", "SS-1"], ["DB1", "DB-1"], ["MF", "Velza"]] as const) ids[k] = partners.find((p) => p.name.startsWith(prefix))?.id ?? "";
  ids.MF = partners.find((p) => p.type === "MANUFACTURER")!.id;
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  delete process.env.VELZA_UPLOAD_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await store().updateSettings({ customsReceiveModes: ["CONTAINER", "LOT"] });
});

describe("receiving at Customs", () => {
  it("container scan → every lot and its packs AT_CUSTOMS; container RECEIVED", async () => {
    const lots = await packedLots(2);
    const c = await containerOnTheWay(lots);
    const r = await receive(ids.vw, { code: c.code });
    expect(r).toMatchObject({ ok: true, status: "AT_CUSTOMS", container: { code: c.code, received: 2, skipped: 0 } });
    expect(r.message).toMatch(/At customs, awaiting clearance/);
    for (const lot of lots) {
      expect(await lotStatus(lot)).toBe("AT_CUSTOMS");
      expect(await packStatuses(lot)).toEqual(["AT_CUSTOMS"]);
    }
    expect((await store().containers.get(c.id))?.status).toBe("RECEIVED");
  });

  it("lot scan → AT_CUSTOMS and its container becomes RECEIVED", async () => {
    const lots = await packedLots(2);
    const c = await containerOnTheWay(lots);
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: true, status: "AT_CUSTOMS" });
    expect((await store().containers.get(c.id))?.status).toBe("RECEIVED");
  });

  it("container scan after one lot was received alone → receives the rest, not DUPLICATE_RECEIPT", async () => {
    const lots = await packedLots(3);
    const c = await containerOnTheWay(lots);
    await receive(ids.vw, { code: lots[0] });
    expect(await receive(ids.vw, { code: c.code })).toMatchObject({ ok: true, status: "AT_CUSTOMS", container: { received: 2, skipped: 1 } });
    for (const lot of lots) expect(await lotStatus(lot)).toBe("AT_CUSTOMS");
  });

  it("second container scan with nothing left → DUPLICATE_RECEIPT", async () => {
    const lots = await packedLots(1);
    const c = await containerOnTheWay(lots);
    await receive(ids.vw, { code: c.code });
    expect(await receive(ids.vw, { code: c.code })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });
  });

  it("a loose lot already in transit to Customs at go-live (no container) arrives cleared: AT_WAREHOUSE", async () => {
    const [lot] = await packedLots(1);
    await place(lot, { status: "IN_TRANSIT", locationId: ids.MF, inTransitToId: ids.VW });
    expect(await receive(ids.vw, { code: lot })).toMatchObject({ ok: true, status: "AT_WAREHOUSE" });
    expect(await packStatuses(lot)).toEqual(["AT_WAREHOUSE"]);
  });

  it("receive methods follow the setting", async () => {
    const lots = await packedLots(2);
    const c = await containerOnTheWay(lots);
    await store().updateSettings({ customsReceiveModes: ["CONTAINER"] });
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: false, code: "RECEIVE_MODE_OFF", message: expect.stringMatching(/scan the container number/) });
    await store().updateSettings({ customsReceiveModes: ["LOT"] });
    expect(await receive(ids.vw, { code: c.code })).toMatchObject({ ok: false, code: "RECEIVE_MODE_OFF", message: expect.stringMatching(/scan each case or tray/) });
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: true, status: "AT_CUSTOMS" });
    expect(await lotStatus(lots[1])).toBe("IN_TRANSIT");
  });

  it("a return arrives at Customs as RETURNED even when only container scans are allowed", async () => {
    const [lot] = await packedLots(1);
    await place(lot, { status: "AT_SS", locationId: ids.SS1 });
    expect(await takeBack(FIELD, { code: lot, reason: "NOT_SELLING" })).toMatchObject({ ok: true });
    await store().updateSettings({ customsReceiveModes: ["CONTAINER"] });
    expect(await receive(ids.vw, { code: lot })).toMatchObject({ ok: true, status: "RETURNED" });
  });
});

describe("clearing a container at Customs", () => {
  /** A container shipped and fully received at Customs (held). */
  async function received(n: number) {
    const lots = await packedLots(n);
    const c = await containerOnTheWay(lots);
    await receive(ids.vw, { code: c.code });
    return { lots, ...c };
  }

  it("clear → lots and packs AT_WAREHOUSE, a CUSTOMS_CLEARED movement with the Bill of Entry, container CLEARED", async () => {
    const { lots, id } = await received(2);
    const r = await clearContainer(ids.vw, id, { billOfEntry: "  BE-1234567 " });
    expect(r).toMatchObject({ ok: true, cleared: 2, notHere: 0, container: { status: "CLEARED", billOfEntry: "BE-1234567", clearedBy: ids.vw } });
    expect(r.message).toMatch(/cleared: 2 case\(s\)\/tray\(s\) ready to dispatch/);
    for (const lot of lots) {
      expect(await lotStatus(lot)).toBe("AT_WAREHOUSE");
      expect(await packStatuses(lot)).toEqual(["AT_WAREHOUSE"]);
      const moves = await store().movements.list({ itemCode: lot, type: "CUSTOMS_CLEARED" });
      expect(moves).toEqual([expect.objectContaining({ fromStatus: "AT_CUSTOMS", toStatus: "AT_WAREHOUSE", fromId: ids.VW, toId: ids.VW, note: "Bill of Entry BE-1234567" })]);
    }
  });

  it("clear before anything arrived → CONTAINER_NOT_RECEIVED; clear twice → ALREADY_CLEARED; Bill of Entry over 40 chars refused", async () => {
    const lots = await packedLots(1);
    const c = await containerOnTheWay(lots);
    await expect(clearContainer(ids.vw, c.id, {})).rejects.toMatchObject({ code: "CONTAINER_NOT_RECEIVED" });
    await receive(ids.vw, { code: c.code });
    await expect(clearContainer(ids.vw, c.id, { billOfEntry: "X".repeat(41) })).rejects.toThrow();
    await clearContainer(ids.vw, c.id, {});
    await expect(clearContainer(ids.vw, c.id, {})).rejects.toMatchObject({ code: "ALREADY_CLEARED" });
  });

  it("only the Customs user clears", async () => {
    const { id } = await received(1);
    for (const who of [ids.ss1, ids.operator, ids.hq]) await expect(clearContainer(who, id, {})).rejects.toMatchObject({ status: 403 });
  });

  it("early clear: 1 of 3 received, cleared, then a container scan brings the other 2 in cleared", async () => {
    const lots = await packedLots(3);
    const c = await containerOnTheWay(lots);
    await receive(ids.vw, { code: lots[0] });
    expect((await getContainer(ids.vw, c.id)).container).toMatchObject({ receivedCount: 1, total: 3 });
    expect(await clearContainer(ids.vw, c.id, {})).toMatchObject({ cleared: 1, notHere: 2 });
    expect(await receive(ids.vw, { code: c.code })).toMatchObject({ ok: true, status: "AT_WAREHOUSE", container: { received: 2 } });
    for (const lot of lots) expect(await lotStatus(lot)).toBe("AT_WAREHOUSE");
  });

  it("a damaged lot in the container stays DAMAGED when the container is cleared", async () => {
    const { lots, id } = await received(2);
    expect(await reportDamaged(ids.vw, { code: lots[0], reason: "Crushed at the port", ...photoOf(lots[0]) })).toMatchObject({ ok: true });
    expect(await clearContainer(ids.vw, id, {})).toMatchObject({ cleared: 1, notHere: 1 });
    expect(await lotStatus(lots[0])).toBe("DAMAGED");
    expect(await lotStatus(lots[1])).toBe("AT_WAREHOUSE");
  });

  it("held stock is recalled by a batch recall", async () => {
    const { lots } = await received(1);
    const batchCode = (await store().lots.findOne({ lotCode: lots[0] }))!.batchCode;
    await recall(ids.hq, { batchCode, reason: "Customs test recall" });
    expect(await lotStatus(lots[0])).toBe("RECALLED");
  });

  it("after clearing, Customs dispatches to an SS; never to a Distributor; held stock never", async () => {
    const held = await received(1);
    expect(await dispatch(ids.vw, { action: "check", toPartnerId: ids.SS1, invoice: "INV-H", code: held.lots[0] })).toMatchObject({ ok: false, code: "NOT_CLEARED" });
    const { lots, id } = await received(1);
    await clearContainer(ids.vw, id, {});
    expect(await dispatch(ids.vw, { action: "check", toPartnerId: ids.DB1, invoice: "INV-W", code: lots[0] })).toMatchObject({ ok: false, code: "WRONG_DESTINATION" });
    expect(await dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-W", codes: lots })).toMatchObject({ ok: true });
  });

  it("a cleared container's number can be used for a new container", async () => {
    const { code, id } = await received(1);
    await clearContainer(ids.vw, id, {});
    expect(await createContainer(ids.operator, { code })).toMatchObject({ container: { code, status: "LOADING" } });
  });
});

describe("Admin setting: how Customs receives", () => {
  it("at least one method is required; container-only then refuses a case scan at Customs", async () => {
    await expect(updateSettings(ids.admin, { customsReceiveModes: [] })).rejects.toThrow();
    await expect(updateSettings(ids.admin, { customsReceiveModes: ["PALLET"] })).rejects.toThrow();
    await expect(updateSettings(ids.ss1, { customsReceiveModes: ["CONTAINER"] })).rejects.toMatchObject({ status: 403 });
    expect(await updateSettings(ids.admin, { customsReceiveModes: ["CONTAINER"] })).toMatchObject({ customsReceiveModes: ["CONTAINER"] });
    const lots = await packedLots(1);
    await containerOnTheWay(lots);
    expect(await receive(ids.vw, { code: lots[0] })).toMatchObject({ ok: false, code: "RECEIVE_MODE_OFF" });
  });
});

describe("final review fixes (16 Nov 2026)", () => {
  it("container-only setting: a loose lot in transit at go-live (no container to scan) is still received, cleared", async () => {
    const [lot] = await packedLots(1);
    await place(lot, { status: "IN_TRANSIT", locationId: ids.MF, inTransitToId: ids.VW });
    await store().updateSettings({ customsReceiveModes: ["CONTAINER"] });
    expect(await receive(ids.vw, { code: lot })).toMatchObject({ ok: true, status: "AT_WAREHOUSE" });
  });

  it("'n of N received' keeps counting a case that has since been sent on to an SS", async () => {
    const lots = await packedLots(2);
    const c = await containerOnTheWay(lots);
    await receive(ids.vw, { code: lots[0] });
    await clearContainer(ids.vw, c.id, {});
    expect(await dispatch(ids.vw, { action: "confirm", toPartnerId: ids.SS1, invoice: "INV-ON", codes: [lots[0]] })).toMatchObject({ ok: true });
    expect((await getContainer(ids.vw, c.id)).container).toMatchObject({ receivedCount: 1, total: 2 });
  });
});
