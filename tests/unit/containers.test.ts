// Shipping containers plant → Velza Warehouse: open by the container's own number, scan cases and trays in,
// dispatch the whole container (all lots or none), and the warehouse receives it with one scan of its number.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Role } from "@/lib/core/types";
import { getStore } from "@/lib/store";
import { cancelContainer, createContainer, dispatchContainer, getContainer, listContainers, loadContainer, unloadContainer } from "@/lib/services/containers";
import { dispatch, receive } from "@/lib/services/movement";
import { createPrintOrder, markPrinted } from "@/lib/services/printOrders";
import { lookup } from "@/lib/services/trace";
import { verify } from "@/lib/services/verify";
import { buildSampleSeed } from "../fixtures/sampleNetwork";

let dir: string;
const ids: Record<string, string> = {};
const store = () => getStore();

async function user(role: Role, partnerPrefix?: string) {
  const [users, partners] = await Promise.all([store().users.list({ role }), store().partners.list()]);
  return users.find((u) => !partnerPrefix || partners.find((p) => p.id === u.partnerId)?.name.startsWith(partnerPrefix))!.id;
}
const partner = async (prefix: string) => (await store().partners.list()).find((p) => p.name.startsWith(prefix))!.id;

/** Cases and trays printed and passed by QC (PACKED at the plant). */
async function packedLots(cases: number, trays: number) {
  const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "OR", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases, trays }] });
  if (r.preview) throw new Error("expected an order");
  await markPrinted(ids.operator, r.printOrder.id);
  for (const lotCode of r.printOrder.lotCodes) {
    const packs = (await store().packs.list({ lotCode })).sort((a, b) => a.seq - b.seq).map((p) => p.packCode);
    await verify(ids.qc, { action: "scanLot", code: lotCode });
    await verify(ids.qc, { action: "confirm", lotCode, packCodes: packs });
  }
  return r.printOrder.lotCodes;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "velza-containers-"));
  process.env.VELZA_DB_PATH = path.join(dir, "db.json");
  await store().reset(buildSampleSeed());
  ids.operator = await user("OPERATOR");
  ids.qc = await user("QC");
  ids.vw = await user("WAREHOUSE");
  ids.ss1 = await user("SS", "SS-1");
  ids.hq = await user("TRACE_OWNER");
  ids.VW = await partner("VW-1");
  ids.SS1 = await partner("SS-1");
});
afterAll(async () => {
  delete process.env.VELZA_DB_PATH;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("shipping containers", () => {
  let lots: string[];
  let containerId: string;

  it("the operator opens a container by its own number; the number is checked", async () => {
    lots = await packedLots(2, 1);
    const r = await createContainer(ids.operator, { code: " mscu 1234567 " });
    expect(r.container).toMatchObject({ code: "MSCU1234567", status: "LOADING", lotCodes: [] });
    containerId = r.container.id;
    // still loading → the same number can't be opened again
    await expect(createContainer(ids.operator, { code: "MSCU1234567" })).rejects.toMatchObject({ code: "CONTAINER_IN_USE" });
    await expect(createContainer(ids.operator, { code: "ab" })).rejects.toMatchObject({ code: "BAD_CONTAINER_CODE" });
    await expect(createContainer(ids.operator, { code: lots[0] })).rejects.toMatchObject({ code: "BAD_CONTAINER_CODE" });
    // only the plant's operator
    for (const who of [ids.qc, ids.vw, ids.ss1, ids.hq]) await expect(createContainer(who, { code: "TGHU7654321" })).rejects.toMatchObject({ status: 403 });
  });

  it("loads packed cases and trays only, once each", async () => {
    for (const code of lots) expect(await loadContainer(ids.operator, containerId, { code })).toMatchObject({ ok: true });
    expect(await loadContainer(ids.operator, containerId, { code: lots[0] })).toMatchObject({ ok: false, code: "DUPLICATE_SCAN" });
    expect(await loadContainer(ids.operator, containerId, { code: `${lots[0]}61` })).toMatchObject({ ok: false, code: "INVALID_CODE" });
    expect(await loadContainer(ids.operator, containerId, { code: "91ZZZZZZOR00001" })).toMatchObject({ ok: false, code: "UNKNOWN_CODE" });
    // printed but not verified by QC
    const r = await createPrintOrder(ids.operator, { idempotencyKey: crypto.randomUUID(), batches: [{ flavour: "GA", mfgDate: "2026-11-01", expiryDate: "2027-08-01", cases: 1, trays: 0 }] });
    if (r.preview) throw new Error("expected an order");
    await markPrinted(ids.operator, r.printOrder.id);
    expect(await loadContainer(ids.operator, containerId, { code: r.printOrder.lotCodes[0] })).toMatchObject({ ok: false, code: "WRONG_STATUS", message: expect.stringMatching(/QC must verify/) });
    // a case in one loading container can't go into another
    const second = await createContainer(ids.operator, { code: "TGHU7654321" });
    expect(await loadContainer(ids.operator, second.container.id, { code: lots[0] })).toMatchObject({ ok: false, message: expect.stringMatching(/already in container MSCU1234567/) });
    await cancelContainer(ids.operator, second.container.id);

    // take one out and put it back
    expect(await unloadContainer(ids.operator, containerId, { code: lots[2] })).toMatchObject({ ok: true, count: 2 });
    expect(await loadContainer(ids.operator, containerId, { code: lots[2] })).toMatchObject({ ok: true, count: 3 });
    const detail = await getContainer(ids.operator, containerId);
    expect(detail).toMatchObject({ cases: 2, trays: 1, capacity: 2860 });
    expect(detail.lots.map((l) => l.code)).toEqual(lots);
    expect((await store().scans.list({ context: "CONTAINER" })).length).toBeGreaterThan(0);
  });

  it("dispatches the whole container to the Velza Warehouse only, all lots at once", async () => {
    await expect(dispatchContainer(ids.operator, containerId, { toPartnerId: ids.SS1, invoice: "INV-C1" })).rejects.toMatchObject({ code: "WRONG_DESTINATION" });
    await expect(dispatchContainer(ids.operator, containerId, { toPartnerId: ids.VW, invoice: " " })).rejects.toMatchObject({ code: "INVOICE_REQUIRED" });
    const r = await dispatchContainer(ids.operator, containerId, { toPartnerId: ids.VW, invoice: "INV-C1" });
    expect(r.container).toMatchObject({ status: "IN_TRANSIT", toId: ids.VW, invoice: "INV-C1", dispatchedAt: expect.any(String) });
    for (const code of lots) expect(await store().lots.findOne({ lotCode: code })).toMatchObject({ status: "IN_TRANSIT", inTransitToId: ids.VW });
    const moves = (await store().movements.list({ type: "DISPATCHED" })).filter((m) => lots.includes(m.itemCode));
    expect(moves.map((m) => [m.invoice, m.note])).toEqual(lots.map(() => ["INV-C1", "Container MSCU1234567"]));
    // no longer loading: can't be changed or dispatched again
    await expect(loadContainer(ids.operator, containerId, { code: lots[0] })).rejects.toMatchObject({ code: "CONTAINER_NOT_LOADING" });
    await expect(dispatchContainer(ids.operator, containerId, { toPartnerId: ids.VW, invoice: "INV-C1" })).rejects.toMatchObject({ code: "CONTAINER_NOT_LOADING" });
    await expect(cancelContainer(ids.operator, containerId)).rejects.toMatchObject({ code: "CONTAINER_NOT_LOADING" });
  });

  it("a container with a lot that can't go is not dispatched at all", async () => {
    const [a, b] = await packedLots(2, 0);
    const c = (await createContainer(ids.operator, { code: "CAIU1111111" })).container;
    for (const code of [a, b]) await loadContainer(ids.operator, c.id, { code });
    // b leaves the plant on its own in the meantime
    await dispatch(ids.operator, { action: "confirm", toPartnerId: ids.VW, invoice: "INV-LOOSE", codes: [b] });
    await expect(dispatchContainer(ids.operator, c.id, { toPartnerId: ids.VW, invoice: "INV-C2" })).rejects.toMatchObject({ code: "DISPATCH_REJECTED", details: [expect.objectContaining({ code: b })] });
    expect(await store().lots.findOne({ lotCode: a })).toMatchObject({ status: "PACKED" });
    expect((await store().containers.get(c.id))!.status).toBe("LOADING");
    await expect(dispatchContainer(ids.operator, (await createContainer(ids.operator, { code: "CAIU2222222" })).container.id, { toPartnerId: ids.VW, invoice: "X" })).rejects.toMatchObject({ code: "CONTAINER_EMPTY" });
  });

  it("the warehouse receives the whole container with one scan of its number", async () => {
    // someone else scanning the container number
    expect(await receive(ids.ss1, { code: "MSCU1234567" })).toMatchObject({ ok: false, code: "WRONG_RECEIVER" });
    // one case was received on its own first: the container scan receives the rest
    expect(await receive(ids.vw, { code: lots[1] })).toMatchObject({ ok: true, status: "AT_WAREHOUSE" });
    const r = await receive(ids.vw, { code: "mscu1234567" });
    expect(r).toMatchObject({ ok: true, status: "AT_WAREHOUSE", container: { code: "MSCU1234567", received: 2, skipped: 1 } });
    for (const code of lots) expect(await store().lots.findOne({ lotCode: code })).toMatchObject({ status: "AT_WAREHOUSE", locationId: ids.VW, inTransitToId: null });
    for (const code of lots) expect((await store().packs.list({ lotCode: code })).every((p) => p.status === "AT_WAREHOUSE")).toBe(true);
    expect(await store().containers.get(containerId)).toMatchObject({ status: "RECEIVED", receivedAt: expect.any(String) });
    expect(await receive(ids.vw, { code: "MSCU1234567" })).toMatchObject({ ok: false, code: "DUPLICATE_RECEIPT" });

    // HQ sees the container and the case's history names it
    const t = await lookup(ids.hq, lots[0]);
    if (!t.found) throw new Error("not found");
    expect(t.timeline.filter((e) => e.event === "DISPATCHED" || e.event === "RECEIVED").map((e) => [e.event, e.invoice, e.note])).toEqual([
      ["DISPATCHED", "INV-C1", "Container MSCU1234567"],
      ["RECEIVED", "INV-C1", "Container MSCU1234567"],
    ]);
    expect((await listContainers(ids.hq)).containers.find((c) => c.id === containerId)).toMatchObject({ code: "MSCU1234567", status: "RECEIVED", lots: 3, to: expect.stringMatching(/VW-1/) });
    // the warehouse sees containers sent to it; SS and DB have no container access
    expect((await listContainers(ids.vw)).containers.map((c) => c.code)).toEqual(["MSCU1234567"]);
    await expect(listContainers(ids.ss1)).rejects.toMatchObject({ status: 403 });
  });

  it("after a trip is received, the same container number can be used for the next trip", async () => {
    const next = await createContainer(ids.operator, { code: "MSCU1234567" });
    expect(next.container).toMatchObject({ code: "MSCU1234567", status: "LOADING" });
    expect(next.container.id).not.toBe(containerId);
  });
});
