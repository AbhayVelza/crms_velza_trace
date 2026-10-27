// Guided print order: preview (summary step), create (allocates codes), print view data, mark printed.

import { z } from "zod";
import { allocateLots, stickerCount } from "@/lib/core/codes";
import { planPrintOrder } from "@/lib/core/printOrder";
import { stickerForCode, stickersForLots, type Sticker } from "@/lib/core/stickers";
import type { Batch, Lot, Pack, PrintOrder } from "@/lib/core/types";
import { getStore, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, manufacturerDevice, notFound, nowIso, requireAction, requirePartner, type Actor } from "./common";
import { autoRefill, reservedCodes } from "./pool";

export const printOrderSchema = z.object({
  deviceId: z.string().optional(),
  preview: z.boolean().optional(),
  batches: z
    .array(
      z.object({
        flavour: z.string(),
        mfgDate: z.string(),
        expiryDate: z.string(),
        cases: z.number(),
        trays: z.number(),
      }),
    )
    .max(50),
});

async function operatorContext(tx: StoreTx, userId: string | null, deviceId?: string) {
  const actor = await loadActor(tx, userId);
  requireAction(actor, "printOrder");
  const manufacturer = requirePartner(actor);
  const device = await manufacturerDevice(tx, manufacturer.id, deviceId);
  return { actor, manufacturer, device };
}

async function plan(tx: StoreTx, deviceId: string, batches: z.infer<typeof printOrderSchema>["batches"]) {
  const [settings, pool, flavours] = await Promise.all([tx.getSettings(), reservedCodes(tx, deviceId), tx.flavours.list({ active: true })]);
  return planPrintOrder({
    batches,
    country: settings.defaultCountry,
    poolCodes: pool.map((p) => p.code),
    flavours: flavours.map((f) => f.code),
  });
}

export async function createPrintOrder(userId: string | null, body: unknown) {
  const input = printOrderSchema.parse(body);
  const store = getStore();

  if (input.preview) {
    const { device } = await operatorContext(store, userId, input.deviceId);
    return { preview: true as const, device, plan: await plan(store, device.id, input.batches) };
  }

  return store.transaction(async (tx) => {
    const { actor, manufacturer, device } = await operatorContext(tx, userId, input.deviceId);
    const summary = await plan(tx, device.id, input.batches);
    if (!summary.ok) throw badRequest("INVALID_ORDER", summary.errors.map((e) => e.message).join("; "), summary.errors);

    const settings = await tx.getSettings();
    const pool = await reservedCodes(tx, device.id);
    const at = nowIso();
    const synced = !device.offline;
    const printOrderId = crypto.randomUUID();
    const lotRows: Lot[] = [];
    const packRows: Pack[] = [];
    const batchCodes: string[] = [];

    for (const [i, b] of input.batches.entries()) {
      const poolEntry = pool[i];
      await tx.batchCodePool.update(poolEntry.id, { status: "USED", usedAt: at });
      const batch: Batch = {
        id: crypto.randomUUID(),
        code: poolEntry.code,
        country: settings.defaultCountry,
        flavour: b.flavour,
        mfgDate: b.mfgDate,
        expiryDate: b.expiryDate,
        manufacturerId: manufacturer.id,
        deviceId: device.id,
        nextLot: 1,
        status: "ACTIVE",
        synced,
        printOrderId,
        createdAt: at,
        createdBy: actor.user.id,
        recalledAt: null,
        recallReason: null,
      };
      await tx.batches.create(batch);
      batchCodes.push(batch.code);

      const first = await tx.nextLotNumber(batch.code, b.cases + b.trays);
      const { lots } = allocateLots({ ...batch, nextLot: first }, b.cases, b.trays);
      for (const l of lots) {
        lotRows.push({
          id: l.lotCode, // a code row is keyed by its printed code
          lotCode: l.lotCode,
          batchCode: batch.code,
          flavour: batch.flavour,
          lotType: l.lotType,
          packSize: l.packSize,
          lotNumber: l.lotNumber,
          status: "GENERATED",
          locationId: manufacturer.id,
          inTransitToId: null,
          dispatchedAt: null,
          printOrderId,
          manufacturerId: manufacturer.id,
          deviceId: device.id,
          synced,
          quarantineReason: null,
          statusBeforeRecall: null,
          createdAt: at,
          updatedAt: at,
        });
        l.packCodes.forEach((packCode, idx) =>
          packRows.push({
            id: packCode,
            packCode,
            lotCode: l.lotCode,
            seq: idx + 1,
            packSize: l.packSize,
            status: "GENERATED",
            locationId: manufacturer.id,
            inTransitToId: null,
            dispatchedAt: null,
            statusBeforeRecall: null,
            createdAt: at,
            updatedAt: at,
          }),
        );
      }
    }

    const existing = new Set((await tx.lots.list()).map((l) => l.lotCode));
    if (lotRows.some((l) => existing.has(l.lotCode))) throw new Error("Duplicate lot code generated — aborting");
    await tx.lots.createMany(lotRows);
    await tx.packs.createMany(packRows);

    const order: PrintOrder = {
      id: printOrderId,
      createdAt: at,
      createdBy: actor.user.id,
      deviceId: device.id,
      manufacturerId: manufacturer.id,
      batchCodes,
      lotCodes: lotRows.map((l) => l.lotCode),
      stickerCount: input.batches.reduce((s, b) => s + stickerCount(b.cases, b.trays), 0),
      status: "CREATED",
      printedAt: null,
      synced,
    };
    await tx.printOrders.create(order);
    for (const l of lotRows) {
      await tx.appendMovement({
        type: "GENERATED",
        itemKind: "LOT",
        itemCode: l.lotCode,
        fromId: null,
        toId: manufacturer.id,
        fromStatus: null,
        toStatus: "GENERATED",
        userId: actor.user.id,
        deviceId: device.id,
        invoice: null,
        note: `Print order ${printOrderId.slice(0, 8)}${synced ? "" : " (offline)"}`,
      });
    }
    await autoRefill(tx, device.id);
    return { preview: false as const, printOrder: order, plan: summary };
  });
}

export async function listPrintOrders(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "printOrder");
  const manufacturer = requirePartner(actor);
  const [orders, batches, lots, users] = await Promise.all([
    store.printOrders.list({ manufacturerId: manufacturer.id }),
    store.batches.list({ manufacturerId: manufacturer.id }),
    store.lots.list({ manufacturerId: manufacturer.id }),
    store.users.list(),
  ]);
  return orders
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((o) => ({
      ...o,
      createdByName: users.find((u) => u.id === o.createdBy)?.name ?? o.createdBy,
      batches: batches
        .filter((b) => b.printOrderId === o.id)
        .map((b) => {
          const bl = lots.filter((l) => l.batchCode === b.code);
          return {
            code: b.code,
            flavour: b.flavour,
            synced: b.synced,
            cases: bl.filter((l) => l.lotType === "CASE").length,
            trays: bl.filter((l) => l.lotType === "TRAY").length,
          };
        }),
    }));
}

/** One generated sticker with every field of its row in the codes table. */
export interface CodeRow {
  code: string;
  codeType: "LOT" | "PACK";
  countryCode: string;
  batchCode: string;
  flavour: string;
  hexCode: string;
  lotType: "CASE" | "TRAY";
  packSize: number;
  packSequence: number | null;
  lotCode: string;
  mfgDate: string;
  expiryDate: string;
  manufacturerId: string;
  status: string;
  locationId: string;
  synced: boolean;
  generatedAt: string;
  generatedBy: string;
}

/**
 * Every code a print order generated, with all its fields (as stored in the codes table), and the
 * totals: stickers, cases, trays, packs, and how many are synced to the central database.
 */
export async function codesForOrder(userId: string | null, printOrderId: string) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "printOrder");
  const order = await requireOwnOrder(store, actor, printOrderId);
  const [lots, batches, packs] = await Promise.all([store.lots.list({ printOrderId }), store.batches.list({ printOrderId }), store.packs.list()]);
  const batchOf = new Map(batches.map((b) => [b.code, b]));
  const byLot = new Map<string, Pack[]>(lots.map((l) => [l.lotCode, []]));
  for (const p of packs) byLot.get(p.lotCode)?.push(p);
  const rows: CodeRow[] = [];
  for (const code of order.lotCodes) {
    const l = lots.find((x) => x.lotCode === code);
    if (!l) continue;
    const b = batchOf.get(l.batchCode)!;
    const common = {
      countryCode: l.lotCode.slice(0, 2),
      batchCode: l.batchCode,
      flavour: l.flavour,
      hexCode: l.lotCode.slice(10, 15),
      lotType: l.lotType,
      packSize: l.packSize,
      lotCode: l.lotCode,
      mfgDate: b.mfgDate,
      expiryDate: b.expiryDate,
      manufacturerId: l.manufacturerId,
      synced: l.synced,
      generatedAt: l.createdAt,
      generatedBy: b.createdBy,
    };
    rows.push({ ...common, code: l.lotCode, codeType: "LOT", packSequence: null, status: l.status, locationId: l.locationId });
    for (const p of (byLot.get(l.lotCode) ?? []).sort((x, y) => x.seq - y.seq)) {
      rows.push({ ...common, code: p.packCode, codeType: "PACK", packSequence: p.seq, status: p.status, locationId: p.locationId });
    }
  }
  return {
    printOrder: order,
    totals: {
      stickers: rows.length,
      cases: lots.filter((l) => l.lotType === "CASE").length,
      trays: lots.filter((l) => l.lotType === "TRAY").length,
      packs: rows.filter((r) => r.codeType === "PACK").length,
      synced: rows.filter((r) => r.synced).length,
      unsynced: rows.filter((r) => !r.synced).length,
    },
    codes: rows,
  };
}

async function flavourNames(tx: StoreTx) {
  const flavours = await tx.flavours.list();
  return (code: string) => flavours.find((f) => f.code === code)?.name ?? code;
}

async function requireOwnOrder(tx: StoreTx, actor: Actor, id: string) {
  const order = await tx.printOrders.get(id);
  if (!order || order.manufacturerId !== actor.partner?.id) throw notFound(`Print order ${id}`);
  return order;
}

export interface StickerSheet {
  title: string;
  stickers: Sticker[];
  lotSize: { widthMm: number; heightMm: number };
  packSize: { widthMm: number; heightMm: number };
  printOrder: PrintOrder | null;
}

export async function stickersForOrder(userId: string | null, printOrderId: string): Promise<StickerSheet> {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "printOrder");
  const order = await requireOwnOrder(store, actor, printOrderId);
  const [settings, name, lots] = await Promise.all([store.getSettings(), flavourNames(store), store.lots.list({ printOrderId })]);
  const ordered = order.lotCodes.map((c) => lots.find((l) => l.lotCode === c)).filter((l): l is Lot => !!l);
  return {
    title: `Print order ${order.id.slice(0, 8)} · ${order.stickerCount} stickers`,
    stickers: stickersForLots(
      ordered.map((l) => ({ lotCode: l.lotCode, lotType: l.lotType, flavourName: name(l.flavour) })),
      settings.publicBaseUrl,
    ),
    lotSize: settings.lotSticker,
    packSize: settings.packSticker,
    printOrder: order,
  };
}

export async function stickerForReprint(userId: string | null, code: string): Promise<StickerSheet> {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "reprint");
  const lot = await store.lots.findOne({ lotCode: code.slice(0, 15) });
  if (!lot || lot.manufacturerId !== actor.partner?.id) throw notFound(`Code ${code}`);
  const [settings, name] = await Promise.all([store.getSettings(), flavourNames(store)]);
  const sticker = stickerForCode(code, { lotCode: lot.lotCode, lotType: lot.lotType, flavourName: name(lot.flavour) }, settings.publicBaseUrl);
  if (!sticker) throw notFound(`Code ${code}`);
  return { title: `Reprint ${code}`, stickers: [sticker], lotSize: settings.lotSticker, packSize: settings.packSticker, printOrder: null };
}

/** Called after window.print(): GENERATED lots of the order become PRINTED. */
export async function markPrinted(userId: string | null, printOrderId: string) {
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "printOrder");
    const order = await requireOwnOrder(tx, actor, printOrderId);
    const at = nowIso();
    const lots = await tx.lots.list({ printOrderId });
    let changed = 0;
    for (const lot of lots.filter((l) => l.status === "GENERATED")) {
      await tx.lots.update(lot.id, { status: "PRINTED", updatedAt: at });
      for (const p of await tx.packs.list({ lotCode: lot.lotCode })) {
        if (p.status === "GENERATED") await tx.packs.update(p.id, { status: "PRINTED", updatedAt: at });
      }
      await tx.appendMovement({
        type: "PRINTED",
        itemKind: "LOT",
        itemCode: lot.lotCode,
        fromId: lot.locationId,
        toId: lot.locationId,
        fromStatus: "GENERATED",
        toStatus: "PRINTED",
        userId: actor.user.id,
        deviceId: order.deviceId,
        invoice: null,
        note: null,
      });
      changed++;
    }
    const updated = await tx.printOrders.update(order.id, { status: "PRINTED", printedAt: order.printedAt ?? at });
    return { printOrder: updated, lotsPrinted: changed };
  });
}
