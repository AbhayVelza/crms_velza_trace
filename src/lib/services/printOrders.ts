// Guided print order: preview (summary step), create (allocates codes), print view data, mark printed.

import { z } from "zod";
import { allocateLots, batchCounter, CONTINUE_MAX_LOTS, JSON_CONTINUE_MAX_LOTS, stickerCount, type BatchCounter } from "@/lib/core/codes";
import { planPrintOrder } from "@/lib/core/printOrder";
import { stickerForCode, stickersForLots, type Sticker } from "@/lib/core/stickers";
import type { Batch, Device, Lot, Pack, PrintOrder } from "@/lib/core/types";
import { getStore, storeKind, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, manufacturerDevice, notFound, nowIso, requireAction, requirePartner, ServiceError, type Actor } from "./common";
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

    // Look up only the new codes (indexed), not every lot ever generated.
    if ((await tx.lots.list({ lotCode: lotRows.map((l) => l.lotCode) })).length) throw new Error("Duplicate lot code generated — aborting");
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

// ---------------------------------------------------------------- continue an existing batch
//
// A new print order that adds lots to an existing batch, from the batch's stored counter (the same
// atomic tx.nextLotNumber as above). The batch row keeps its device, dates, first print order and
// creation history; only next_lot moves. Online devices only, so the central counter is the one authority.
// The idempotency key is the new print order's id, so it is stored in the same transaction as the lots.

export const continueSchema = z.object({
  batchCode: z.string().regex(/^[A-Z0-9]{6}$/, "Batch code must be 6 characters A–Z / 0–9"),
  /** One batch, one flavour: if sent, it must be the batch's own flavour (400 FLAVOUR_CHANGE_NOT_ALLOWED otherwise). */
  flavour: z.string().optional(),
  cases: z.number().int().min(0),
  trays: z.number().int().min(0),
  deviceId: z.string().optional(),
  idempotencyKey: z.uuid().optional(),
  preview: z.boolean().optional(),
});

export type BatchDisplayStatus = "ACTIVE" | "EXHAUSTED" | "COUNTER_INVALID" | "RECALLED";

/** Status shown for a batch: Recalled, then counter invalid, then exhausted (derived, never stored). */
export function batchDisplayStatus(batch: Pick<Batch, "status" | "nextLot">, counter: BatchCounter = batchCounter(batch)): BatchDisplayStatus {
  if (batch.status === "RECALLED") return "RECALLED";
  if (counter.state === "INVALID") return "COUNTER_INVALID";
  return counter.state === "EXHAUSTED" ? "EXHAUSTED" : "ACTIVE";
}

/** Lots one continuation order may add on this server's store. */
export function continueMaxLots(): number {
  return storeKind() === "json" ? JSON_CONTINUE_MAX_LOTS : CONTINUE_MAX_LOTS;
}

interface Problem {
  status: number;
  code: string;
  message: string;
}

const problem = (status: number, code: string, message: string): Problem => ({ status, code, message });

/** Why this batch can't be continued at all (quantity aside), or null. */
function batchProblem(batch: Batch, counter: BatchCounter): Problem | null {
  if (!batch.synced) return problem(409, "BATCH_NOT_SYNCED", `Batch ${batch.code} was created offline and is not synced yet — sync its device first`);
  if (batch.status === "RECALLED") return problem(409, "BATCH_RECALLED", `Batch ${batch.code} is recalled and cannot be continued`);
  if (counter.state === "INVALID") return problem(409, "BATCH_COUNTER_INVALID", `Batch ${batch.code} has an invalid lot counter — contact Velza Admin`);
  if (counter.state === "EXHAUSTED") return problem(409, "BATCH_EXHAUSTED", `Batch ${batch.code} is exhausted: lot 1869F (the maximum) is used. Start a new batch.`);
  return null;
}

/** Device, batch and quantity checks, in order. Every one is enforced here, on the server. */
function continuationProblem(device: Device, batch: Batch, counter: BatchCounter, cases: number, trays: number): Problem | null {
  if (device.offline) return problem(409, "DEVICE_OFFLINE", `${device.name} is offline. Continuing a batch needs the central lot counter — go online first.`);
  const blocked = batchProblem(batch, counter);
  if (blocked) return blocked;
  const total = cases + trays;
  const max = continueMaxLots();
  if (total < 1) return problem(400, "INVALID_QUANTITY", "Enter at least one case or tray");
  if (total > max) {
    const why = storeKind() === "json" ? " on the JSON file store (use PostgreSQL for production volumes)" : "";
    return problem(400, "TOO_MANY_LOTS", `At most ${max.toLocaleString("en-IN")} lots per continuation order${why}; requested ${total.toLocaleString("en-IN")}`);
  }
  if (total > counter.remaining) {
    return problem(409, "INSUFFICIENT_CAPACITY", `Only ${counter.remaining.toLocaleString("en-IN")} lots left in batch ${batch.code} (next ${counter.nextLotHex}, maximum 1869F); requested ${total.toLocaleString("en-IN")}`);
  }
  return null;
}

const toError = (p: Problem) => new ServiceError(p.status, p.code, p.message);

/** What the operator sees about a batch: no user, device or order IDs. */
function batchView(batch: Batch, flavourName: (code: string) => string) {
  const counter = batchCounter(batch);
  const blocked = batchProblem(batch, counter);
  return {
    batchCode: batch.code,
    country: batch.country,
    flavour: batch.flavour,
    flavourName: flavourName(batch.flavour),
    mfgDate: batch.mfgDate,
    expiryDate: batch.expiryDate,
    createdAt: batch.createdAt,
    status: batchDisplayStatus(batch, counter),
    counter,
    continuable: !blocked,
    blockedReason: blocked?.message ?? null,
  };
}

const lotHexOf = (lotCode: string) => lotCode.slice(10, 15);

async function continueContext(tx: StoreTx, userId: string | null, input: z.infer<typeof continueSchema>) {
  const { actor, manufacturer, device } = await operatorContext(tx, userId, input.deviceId);
  const batch = await tx.batches.findOne({ code: input.batchCode });
  // Another manufacturer's batch looks the same as no batch.
  if (!batch || batch.manufacturerId !== manufacturer.id) throw notFound(`Batch ${input.batchCode}`);
  // One batch, one flavour: continued lots always keep the batch's flavour. For another flavour, create a new batch.
  if (input.flavour !== undefined && input.flavour !== batch.flavour) {
    throw new ServiceError(400, "FLAVOUR_CHANGE_NOT_ALLOWED", `Batch ${batch.code} is ${batch.flavour}; a batch carries one flavour only — create a new batch for another flavour`);
  }
  return { actor, manufacturer, device, batch };
}

/**
 * The order already stored under this key. A replay must match the manufacturer, batch, cases, trays
 * and device; otherwise 409, which says nothing about the stored order.
 */
async function replay(tx: StoreTx, existing: PrintOrder, manufacturerId: string, deviceId: string, input: z.infer<typeof continueSchema>) {
  const total = input.cases + input.trays;
  const same =
    existing.manufacturerId === manufacturerId &&
    existing.deviceId === deviceId &&
    existing.batchCodes.length === 1 &&
    existing.batchCodes[0] === input.batchCode &&
    existing.lotCodes.length === total &&
    // with the lot total fixed, 5 × cases + 7 × trays pins down cases and trays
    existing.stickerCount === stickerCount(input.cases, input.trays);
  if (!same) throw new ServiceError(409, "IDEMPOTENCY_KEY_CONFLICT", "This request key was already used for a different request — start the order again");
  const batch = await tx.batches.findOne({ code: input.batchCode });
  return {
    preview: false as const,
    replayed: true,
    printOrder: existing,
    batchCode: input.batchCode,
    firstLotHex: lotHexOf(existing.lotCodes[0]),
    lastLotHex: lotHexOf(existing.lotCodes[existing.lotCodes.length - 1]),
    totalLots: existing.lotCodes.length,
    stickerCount: existing.stickerCount,
    counter: batchCounter(batch ?? { nextLot: null }),
  };
}

/** The manufacturer's batches with their lot counters, and whether each can be continued. */
export async function listContinuableBatches(userId: string | null) {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "printOrder");
  const manufacturer = requirePartner(actor);
  const [batches, name] = await Promise.all([store.batches.list({ manufacturerId: manufacturer.id }), flavourNames(store)]);
  return {
    maxLotsPerOrder: continueMaxLots(),
    batches: batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((b) => batchView(b, name)),
  };
}

/** Preview (read-only: never touches the counter) or create a continuation print order. */
export async function continueBatch(userId: string | null, body: unknown) {
  const input = continueSchema.parse(body);
  const store = getStore();

  if (input.preview) {
    const { device, batch } = await continueContext(store, userId, input);
    const counter = batchCounter(batch);
    const p = continuationProblem(device, batch, counter, input.cases, input.trays);
    const total = input.cases + input.trays;
    const first = batch.nextLot;
    return {
      preview: true as const,
      ok: !p,
      problem: p ? { code: p.code, message: p.message } : null,
      batch: batchView(batch, await flavourNames(store)),
      device: { name: device.name, offline: device.offline },
      cases: input.cases,
      trays: input.trays,
      totalLots: total,
      stickerCount: stickerCount(input.cases, input.trays),
      // Expected only: another order may take these numbers before this one is created.
      expectedFirstLotHex: p ? null : batchCounter({ nextLot: first }).nextLotHex,
      expectedLastLotHex: p ? null : batchCounter({ nextLot: first + total - 1 }).nextLotHex,
      remainingAfter: p ? null : counter.remaining - total,
      maxLotsPerOrder: continueMaxLots(),
    };
  }

  const key = input.idempotencyKey;
  if (!key) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey (a UUID) is required to create a continuation order");

  try {
    return await store.transaction(async (tx) => {
      const { actor, manufacturer, device, batch } = await continueContext(tx, userId, input);
      // Before the batch checks: a request that used the batch's last lots must still replay.
      const existing = await tx.printOrders.get(key);
      if (existing) return replay(tx, existing, manufacturer.id, device.id, input);

      const p = continuationProblem(device, batch, batchCounter(batch), input.cases, input.trays);
      if (p) throw toError(p);

      const total = input.cases + input.trays;
      let first: number;
      try {
        first = await tx.nextLotNumber(batch.code, total);
      } catch (e) {
        if (e instanceof RangeError) throw new ServiceError(409, "INSUFFICIENT_CAPACITY", `Not enough lots left in batch ${batch.code}: ${e.message}`);
        throw e;
      }
      const { lots } = allocateLots({ ...batch, nextLot: first }, input.cases, input.trays);
      const at = nowIso();
      const lotRows: Lot[] = [];
      const packRows: Pack[] = [];
      for (const l of lots) {
        lotRows.push({
          id: l.lotCode,
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
          printOrderId: key,
          manufacturerId: manufacturer.id,
          deviceId: device.id,
          synced: true,
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
      if ((await tx.lots.list({ lotCode: lotRows.map((l) => l.lotCode) })).length) {
        throw new ServiceError(409, "DUPLICATE_ALLOCATION", `Lot codes from ${lots[0].lotHex} already exist in batch ${batch.code} — nothing was allocated`);
      }
      await tx.lots.createMany(lotRows);
      await tx.packs.createMany(packRows);

      const order: PrintOrder = {
        id: key,
        createdAt: at,
        createdBy: actor.user.id,
        deviceId: device.id,
        manufacturerId: manufacturer.id,
        batchCodes: [batch.code],
        lotCodes: lotRows.map((l) => l.lotCode),
        stickerCount: stickerCount(input.cases, input.trays),
        status: "CREATED",
        printedAt: null,
        synced: true,
      };
      await tx.printOrders.create(order);
      const firstLotHex = lots[0].lotHex;
      const lastLotHex = lots[lots.length - 1].lotHex;
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
          note: `Print order ${key.slice(0, 8)} · continues batch ${batch.code} from ${firstLotHex}`,
        });
      }
      return {
        preview: false as const,
        replayed: false,
        printOrder: order,
        batchCode: batch.code,
        firstLotHex,
        lastLotHex,
        totalLots: lotRows.length,
        stickerCount: order.stickerCount,
        counter: batchCounter({ nextLot: first + total }),
      };
    });
  } catch (e) {
    const pg = e as { code?: string; constraint?: string };
    // Same key committed by a concurrent request: answer with that order (or a conflict).
    if (pg.code === "23505" && pg.constraint === "print_orders_pkey") {
      const { manufacturer, device } = await continueContext(store, userId, input);
      const existing = await store.printOrders.get(key);
      if (existing) return replay(store, existing, manufacturer.id, device.id, input);
    }
    if (pg.code === "23505") throw new ServiceError(409, "DUPLICATE_ALLOCATION", "These lot codes already exist — nothing was allocated. Try again.");
    // Serialization retries used up under heavy contention: nothing was committed, so retrying with the same key is safe.
    if (pg.code === "40001" || pg.code === "40P01") throw new ServiceError(409, "ALLOCATION_BUSY", "Another order is being allocated right now — press Create again");
    throw e;
  }
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
      // By the order's batch codes and lots: a continued batch has lots from several orders.
      batches: batches
        .filter((b) => o.batchCodes.includes(b.code))
        .map((b) => {
          const bl = lots.filter((l) => l.batchCode === b.code && l.printOrderId === o.id);
          return {
            code: b.code,
            // Lots continued before 6 Nov 2026 may carry another flavour than the batch's first one.
            flavour: bl[0]?.flavour ?? b.flavour,
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
  const [lots, batches, packs] = await Promise.all([store.lots.list({ printOrderId }), store.batches.list({ code: order.batchCodes }), store.packs.list({ lotCode: order.lotCodes })]);
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
      generatedBy: order.createdBy,
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
    stickers: stickersForLots(ordered.map((l) => ({ lotCode: l.lotCode, lotType: l.lotType, flavourName: name(l.flavour) }))),
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
  const sticker = stickerForCode(code, { lotCode: lot.lotCode, lotType: lot.lotType, flavourName: name(lot.flavour) });
  if (!sticker) throw notFound(`Code ${code}`);
  return { title: `Reprint ${code}`, stickers: [sticker], lotSize: settings.lotSticker, packSize: settings.packSticker, printOrder: null };
}

/**
 * The operator's explicit "Mark as printed" confirmation (never inferred from the print dialog, a CSV download or
 * navigation): GENERATED lots of the order and their packs become PRINTED, one PRINTED movement per lot, and the
 * order gets its printedAt — all in one transaction. Repeating it changes nothing.
 */
export async function markPrinted(userId: string | null, printOrderId: string) {
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "printOrder");
    const order = await requireOwnOrder(tx, actor, printOrderId);
    const at = nowIso();
    const lots = await tx.lots.list({ printOrderId });
    if (order.status !== "PRINTED" && !lots.some((l) => l.status === "GENERATED")) {
      // Every lot was voided (or is otherwise no longer waiting for stickers): nothing to confirm.
      throw badRequest("NOTHING_TO_PRINT", "No lot of this print order is waiting to be printed (voided lots cannot be marked as printed)");
    }
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
