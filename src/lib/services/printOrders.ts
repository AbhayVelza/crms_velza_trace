// Guided print order: preview (summary step), create (allocates codes), print view data, mark printed.
//
// Serial integrity (4 Nov 2026):
// - every order is created under the client's idempotency key (its id) with a request fingerprint; the
//   same key replays only an order of the same kind with the same fingerprint, anything else is a 409;
// - allocation transactions of one manufacturer take a lock (PostgreSQL advisory lock), so concurrent
//   orders queue instead of failing; expected contention answers 409, never a raw 500;
// - a sticker sheet is served only while its order is CREATED (and only lots still GENERATED); every
//   serving is recorded; a PRINTED order's stickers come back only through Reprint;
// - a single sticker is served only against a logged reprint, once.

import { createHash } from "node:crypto";
import { z } from "zod";
import { allocateLots, batchCounter, CONTINUE_MAX_LOTS, JSON_CONTINUE_MAX_LOTS, stickerCount, type BatchCounter } from "@/lib/core/codes";
import { planPrintOrder, summarizePlan } from "@/lib/core/printOrder";
import { canReprint } from "@/lib/core/rules";
import { stickerForCode, stickersForLots, type Sticker } from "@/lib/core/stickers";
import { LOT_TYPES, type Batch, type Device, type Lot, type LotType, type Pack, type PrintOrder } from "@/lib/core/types";
import { getStore, storeKind, type StoreTx } from "@/lib/store";
import { badRequest, loadActor, manufacturerDevice, notFound, nowIso, requireAction, requirePartner, ServiceError, type Actor } from "./common";
import type { Batch, Device, Lot, Pack, PrintOrder, Reprint } from "@/lib/core/types";
import { ConcurrentWriteError, getStore, storeKind, type Store, type StoreTx } from "@/lib/store";
import { badRequest, findItem, loadActor, notFound, nowIso, printDevice, requireAction, requirePartner, ServiceError, type Actor } from "./common";
import { autoRefill, reservedCodes } from "./pool";

// ---------------------------------------------------------------- idempotency and allocation locking

const fingerprint = (parts: unknown) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

type NewBatchInput = { flavour: string; mfgDate: string; expiryDate: string; cases: number; trays: number };

export function newBatchFingerprint(manufacturerId: string, deviceId: string, batches: NewBatchInput[]): string {
  return fingerprint({
    kind: "NEW_BATCH",
    manufacturerId,
    deviceId,
    batches: batches.map((b) => ({ flavour: b.flavour, mfgDate: b.mfgDate, expiryDate: b.expiryDate, cases: b.cases, trays: b.trays })),
  });
}

export function continuationFingerprint(manufacturerId: string, deviceId: string, batchCode: string, cases: number, trays: number): string {
  return fingerprint({ kind: "CONTINUATION", manufacturerId, deviceId, batchCode, cases, trays });
}

const keyConflict = () => new ServiceError(409, "IDEMPOTENCY_KEY_CONFLICT", "This request key was already used for a different request — start the order again");

/** Code allocation of one manufacturer runs one transaction at a time, in every app process. */
async function allocationLockKey(store: Store, userId: string | null): Promise<string> {
  const user = userId ? await store.users.get(userId) : null;
  return `velza:print-allocation:${user?.partnerId ?? "-"}`;
}

/**
 * Expected outcomes of concurrent allocation, as clear 409s (nothing was committed by the failed request,
 * so retrying with the same key is safe). `replayCommitted` answers a concurrent commit of the same key.
 */
async function allocationFailure<T>(e: unknown, replayCommitted: () => Promise<T | null>): Promise<T> {
  const pg = e as { code?: string; constraint?: string };
  if (pg.code === "23505" && pg.constraint === "print_orders_pkey") {
    const r = await replayCommitted();
    if (r) return r;
  }
  if (pg.code === "23505") throw new ServiceError(409, "DUPLICATE_ALLOCATION", "These lot codes already exist — nothing was allocated. Try again.");
  if (pg.code === "40001" || pg.code === "40P01" || pg.code === "55P03" || e instanceof ConcurrentWriteError) {
    throw new ServiceError(409, "ALLOCATION_BUSY", "Another order is being allocated right now — press Create again");
  }
  throw e;
}

export const printOrderSchema = z.object({
  deviceId: z.string().optional(),
  /** Required to create (not to preview): a UUID the client keeps across retries of the same order. */
  idempotencyKey: z.uuid().optional(),
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
    .max(20, "At most 20 batches per print order"),
});

async function operatorContext(tx: StoreTx, userId: string | null, deviceId?: string) {
  const actor = await loadActor(tx, userId);
  requireAction(actor, "printOrder");
  const manufacturer = requirePartner(actor);
  const device = await printDevice(tx, manufacturer.id, deviceId);
  return { actor, manufacturer, device };
}

async function plan(tx: StoreTx, deviceId: string, batches: z.infer<typeof printOrderSchema>["batches"]) {
  // One after another: inside a transaction every query shares one connection.
  const settings = await tx.getSettings();
  const pool = await reservedCodes(tx, deviceId);
  const flavours = await tx.flavours.list({ active: true });
  return planPrintOrder({
    batches,
    country: settings.defaultCountry,
    poolCodes: pool.map((p) => p.code),
    flavours: flavours.map((f) => f.code),
    // The same cap as a continuation order: one order's lots are written (and later marked printed) in one transaction.
    maxLotsPerOrder: continueMaxLots(),
    maxLotsNote: storeKind() === "json" ? " on the JSON file store (use PostgreSQL for production volumes)" : "",
    today: nowIso().slice(0, 10),
  });
}

export async function createPrintOrder(userId: string | null, body: unknown) {
  const input = printOrderSchema.parse(body);
  const store = getStore();

  if (input.preview) {
    const { device } = await operatorContext(store, userId, input.deviceId);
    // Counts and ranges only: never every generated code (a 99,999-lot batch would be megabytes).
    return { preview: true as const, device, plan: summarizePlan(await plan(store, device.id, input.batches)), maxLotsPerOrder: continueMaxLots() };
  }

  const key = input.idempotencyKey;
  if (!key) throw badRequest("IDEMPOTENCY_KEY_REQUIRED", "idempotencyKey (a UUID) is required to create a print order");

  /** The order stored under this key: the same request again (replay), or a conflict that reveals nothing. */
  const replayNew = (existing: PrintOrder, manufacturerId: string, deviceId: string) => {
    if (existing.manufacturerId !== manufacturerId || existing.kind !== "NEW_BATCH" || existing.requestFingerprint !== newBatchFingerprint(manufacturerId, deviceId, input.batches)) {
      throw keyConflict();
    }
    return { preview: false as const, replayed: true, printOrder: existing, plan: null };
  };

  try {
    return await store.transaction(
      async (tx) => {
        const { actor, manufacturer, device } = await operatorContext(tx, userId, input.deviceId);
        const existing = await tx.printOrders.get(key);
        if (existing) return replayNew(existing, manufacturer.id, device.id);
        return { ...(await createNewBatchOrder(tx, actor, manufacturer, device, key, input.batches)), replayed: false };
      },
      { lockKey: await allocationLockKey(store, userId) },
    );
  } catch (e) {
    return allocationFailure(e, async () => {
      const { manufacturer, device } = await operatorContext(store, userId, input.deviceId);
      const existing = await store.printOrders.get(key);
      return existing ? replayNew(existing, manufacturer.id, device.id) : null;
    });
  }
}

async function createNewBatchOrder(
  tx: StoreTx,
  actor: Actor,
  manufacturer: NonNullable<Actor["partner"]>,
  device: Device,
  printOrderId: string,
  batchesIn: z.infer<typeof printOrderSchema>["batches"],
) {
  const input = { batches: batchesIn };
  {
    const summary = await plan(tx, device.id, input.batches);
    if (!summary.ok) throw badRequest("INVALID_ORDER", summary.errors.map((e) => e.message).join("; "), summary.errors);

    const settings = await tx.getSettings();
    const pool = await reservedCodes(tx, device.id);
    const at = nowIso();
    const synced = !device.offline;
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

      // A batch of 0 cases and 0 trays takes its code and no lot numbers; its lots come later by continuing it.
      const first = b.cases + b.trays > 0 ? await tx.nextLotNumber(batch.code, b.cases + b.trays) : batch.nextLot;
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
    if ((await tx.lots.list({ lotCode: lotRows.map((l) => l.lotCode) })).length) {
      throw new ServiceError(409, "DUPLICATE_ALLOCATION", "A generated lot code already exists — nothing was allocated");
    }
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
      kind: "NEW_BATCH",
      requestFingerprint: newBatchFingerprint(manufacturer.id, device.id, input.batches),
    };
    await tx.printOrders.create(order);
    // One GENERATED movement per lot, written in one go.
    await tx.appendMovements(
      lotRows.map((l) => ({
        type: "GENERATED" as const,
        itemKind: "LOT" as const,
        itemCode: l.lotCode,
        fromId: null,
        toId: manufacturer.id,
        fromStatus: null,
        toStatus: "GENERATED" as const,
        userId: actor.user.id,
        deviceId: device.id,
        invoice: null,
        note: `Print order ${printOrderId.slice(0, 8)}${synced ? "" : " (offline)"}`,
      })),
    );
    await autoRefill(tx, device.id);
    return { preview: false as const, printOrder: order, plan: summarizePlan(summary) };
  }
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
  // Either may be 0; with both 0 the order would print nothing.
  if (total < 1) return problem(400, "INVALID_QUANTITY", "Nothing to print: enter cases or trays (either one may be 0)");
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
  const batch = await tx.batches.findOne({ code: input.batchCode });
  let same: boolean;
  if (existing.kind) {
    // Only a continuation order with exactly this request: never a new-batch order, whatever its quantities.
    same =
      existing.manufacturerId === manufacturerId &&
      existing.kind === "CONTINUATION" &&
      existing.requestFingerprint === continuationFingerprint(manufacturerId, deviceId, input.batchCode, input.cases, input.trays);
  } else {
    // Orders made before 4 Nov 2026 have no kind: a continuation is never the order that created its batch.
    const total = input.cases + input.trays;
    same =
      existing.manufacturerId === manufacturerId &&
      existing.deviceId === deviceId &&
      existing.batchCodes.length === 1 &&
      existing.batchCodes[0] === input.batchCode &&
      !!batch &&
      batch.printOrderId !== existing.id &&
      existing.lotCodes.length === total &&
      // with the lot total fixed, 5 × cases + 7 × trays pins down cases and trays
      existing.stickerCount === stickerCount(input.cases, input.trays);
  }
  if (!same) throw keyConflict();
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

  const lockKey = await allocationLockKey(store, userId);
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
        kind: "CONTINUATION",
        requestFingerprint: continuationFingerprint(manufacturer.id, device.id, batch.code, input.cases, input.trays),
      };
      await tx.printOrders.create(order);
      const firstLotHex = lots[0].lotHex;
      const lastLotHex = lots[lots.length - 1].lotHex;
      await tx.appendMovements(
        lotRows.map((l) => ({
          type: "GENERATED" as const,
          itemKind: "LOT" as const,
          itemCode: l.lotCode,
          fromId: null,
          toId: manufacturer.id,
          fromStatus: null,
          toStatus: "GENERATED" as const,
          userId: actor.user.id,
          deviceId: device.id,
          invoice: null,
          note: `Print order ${key.slice(0, 8)} · continues batch ${batch.code} from ${firstLotHex}`,
        })),
      );
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
    }, { lockKey });
  } catch (e) {
    // Same key committed by a concurrent request: answer with that order (or a conflict).
    return allocationFailure(e, async () => {
      const { manufacturer, device } = await continueContext(store, userId, input);
      const existing = await store.printOrders.get(key);
      return existing ? replay(store, existing, manufacturer.id, device.id, input) : null;
    });
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

/** One print run: the cases or the trays of an order, printed on their own label roll and confirmed on their own. */
export interface PrintRun {
  lotType: LotType;
  lots: number;
  stickers: number;
  /** Lots of this run still waiting for "Mark as printed" (GENERATED). */
  pending: number;
}

export interface StickerSheet {
  title: string;
  stickers: Sticker[];
  lotSize: { widthMm: number; heightMm: number };
  packSize: { widthMm: number; heightMm: number };
  printOrder: PrintOrder | null;
  /** Cases first, then trays; only the types the order has. Empty for a reprint. */
  runs: PrintRun[];
}

function printRuns(lots: Lot[], stickers: Sticker[]): PrintRun[] {
  return LOT_TYPES.flatMap((lotType) => {
    const run = lots.filter((l) => l.lotType === lotType);
    if (!run.length) return [];
    return [{ lotType, lots: run.length, stickers: stickers.filter((s) => s.lotType === lotType).length, pending: run.filter((l) => l.status === "GENERATED").length }];
  });
  /** Lots of the order not served because they are no longer waiting to be printed (voided, recalled). */
  withheldLots?: number;
}

/**
 * First-time printing of an order: served only while the order is CREATED (not yet confirmed printed),
 * with only the lots still GENERATED (voided or recalled lots are withheld). Every serving is recorded
 * (PRINT_SHEET_SERVED). A PRINTED order's stickers are never served again here: use Reprint.
 */
export async function stickersForOrder(userId: string | null, printOrderId: string): Promise<StickerSheet> {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "printOrder");
  const order = await requireOwnOrder(store, actor, printOrderId);
  const [settings, name, lots] = await Promise.all([store.getSettings(), flavourNames(store), store.lots.list({ printOrderId })]);
  const ordered = order.lotCodes.map((c) => lots.find((l) => l.lotCode === c)).filter((l): l is Lot => !!l);
  const stickers = stickersForLots(ordered.map((l) => ({ lotCode: l.lotCode, lotType: l.lotType, flavourName: name(l.flavour) })));
  return {
    title: `Print order ${order.id.slice(0, 8)} · ${order.stickerCount} stickers`,
    stickers,
    lotSize: settings.lotSticker,
    packSize: settings.packSticker,
    printOrder: order,
    runs: printRuns(ordered, stickers),
  };
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "printOrder");
    const order = await requireOwnOrder(tx, actor, printOrderId);
    if (order.status === "PRINTED") {
      throw new ServiceError(
        409,
        "ORDER_ALREADY_PRINTED",
        `Print order ${order.id.slice(0, 8)} was confirmed printed${order.printedAt ? ` at ${order.printedAt}` : ""}. Its stickers are not served again: reprint a damaged sticker through Reprint (a reason is required and every reprint is logged).`,
      );
    }
    const settings = await tx.getSettings();
    const name = await flavourNames(tx);
    const lots = await tx.lots.list({ printOrderId });
    const ordered = order.lotCodes.map((c) => lots.find((l) => l.lotCode === c)).filter((l): l is Lot => !!l);
    const printable = ordered.filter((l) => l.status === "GENERATED");
    const withheld = ordered.length - printable.length;
    if (!printable.length) {
      throw new ServiceError(409, "NOTHING_TO_PRINT", "No lot of this print order is waiting to be printed (voided or recalled lots are not printed)");
    }
    const stickers = stickersForLots(
      printable.map((l) => ({ lotCode: l.lotCode, lotType: l.lotType, flavourName: name(l.flavour) })),
      settings.publicBaseUrl,
    );
    await tx.appendMovement({
      type: "PRINT_SHEET_SERVED",
      itemKind: "PRINT_ORDER",
      itemCode: order.id,
      fromId: null,
      toId: null,
      fromStatus: null,
      toStatus: null,
      userId: actor.user.id,
      deviceId: order.deviceId,
      invoice: null,
      note: `${stickers.length} sticker(s) of ${printable.length} lot(s) served for first-time printing${withheld ? `; ${withheld} voided/recalled lot(s) withheld` : ""}`,
    });
    return {
      title: `Print order ${order.id.slice(0, 8)} · ${stickers.length} stickers`,
      stickers,
      lotSize: settings.lotSticker,
      packSize: settings.packSticker,
      printOrder: order,
      withheldLots: withheld,
    };
  });
}

/** The old "any code" single-sticker endpoint: refused, a sticker is printed again only through a logged reprint. */
export function stickerByCodeRefused(): never {
  throw new ServiceError(
    410,
    "REPRINT_REQUIRED",
    "Single stickers are printed only through Reprint: log the reprint with its reason, then open its print view (each logged reprint prints once).",
  );
}

/** Id of the ledger row that marks a reprint authorization as used: unique, so it can be written only once. */
export const reprintServedId = (reprintId: string) => `reprint-served:${reprintId}`;

/**
 * Serve the sticker of one logged reprint, once. Refused if the reprint belongs to another manufacturer,
 * was already used, or its code can no longer be reprinted (VOID, RECALLED or left the factory since).
 * The use is recorded (REPRINT_SERVED) in the same transaction; its fixed row id makes a second use
 * impossible at the storage level, also between concurrent requests and app processes.
 */
export async function serveReprint(userId: string | null, reprintId: string): Promise<StickerSheet & { reprint: Reprint & { servedAt: string } }> {
  const store = getStore();
  const actor = await loadActor(store, userId);
  requireAction(actor, "reprint");
  const lot = await store.lots.findOne({ lotCode: code.slice(0, 15) });
  if (!lot || lot.manufacturerId !== actor.partner?.id) throw notFound(`Code ${code}`);
  const [settings, name] = await Promise.all([store.getSettings(), flavourNames(store)]);
  const sticker = stickerForCode(code, { lotCode: lot.lotCode, lotType: lot.lotType, flavourName: name(lot.flavour) });
  if (!sticker) throw notFound(`Code ${code}`);
  return { title: `Reprint ${code}`, stickers: [sticker], lotSize: settings.lotSticker, packSize: settings.packSticker, printOrder: null, runs: [] };
  const servedId = reprintServedId(reprintId);
  const alreadyUsed = () =>
    new ServiceError(409, "REPRINT_ALREADY_USED", "This reprint was already printed. To print the sticker again, log a new reprint with its reason.");
  try {
    return await store.transaction(async (tx) => {
      const actor = await loadActor(tx, userId);
      requireAction(actor, "reprint");
      const manufacturer = requirePartner(actor);
      const [row] = await tx.reprints.list({ id: reprintId });
      if (!row) throw notFound(`Reprint ${reprintId}`);
      const lot = await tx.lots.findOne({ lotCode: row.code.slice(0, 15) });
      if (!lot || lot.manufacturerId !== manufacturer.id) throw notFound(`Reprint ${reprintId}`);
      if ((await tx.movements.list({ id: servedId })).length) throw alreadyUsed();
      const found = await findItem(tx, row.code, manufacturer.id);
      if (!found.ok) throw notFound(`Code ${row.code}`);
      const check = canReprint(found.item.movable, row.reason);
      if (!check.ok) throw new ServiceError(409, check.code, `${check.message} — this logged reprint can no longer be printed`);
      const settings = await tx.getSettings();
      const name = await flavourNames(tx);
      const sticker = stickerForCode(row.code, { lotCode: lot.lotCode, lotType: lot.lotType, flavourName: name(lot.flavour) }, settings.publicBaseUrl);
      if (!sticker) throw notFound(`Code ${row.code}`);
      const at = nowIso();
      await tx.movements.append({
        id: servedId,
        at,
        type: "REPRINT_SERVED",
        itemKind: row.itemKind,
        itemCode: row.code,
        fromId: null,
        toId: null,
        fromStatus: found.item.movable.status,
        toStatus: found.item.movable.status,
        userId: actor.user.id,
        deviceId: row.deviceId,
        invoice: null,
        note: `Reprint ${reprintId.slice(0, 8)} printed (original order ${(row.printOrderId ?? lot.printOrderId).slice(0, 8)}): ${row.reason}`,
      });
      return {
        title: `Reprint ${row.code}`,
        stickers: [sticker],
        lotSize: settings.lotSticker,
        packSize: settings.packSticker,
        printOrder: null,
        reprint: { ...row, servedAt: at },
      };
    });
  } catch (e) {
    // A concurrent use of the same reprint committed first: the ledger row id is unique.
    const pg = e as { code?: string };
    if (pg.code === "23505" || /duplicate id reprint-served:/.test((e as Error).message ?? "")) throw alreadyUsed();
    if (pg.code === "40001" || pg.code === "40P01") throw new ServiceError(409, "REPRINT_BUSY", "The reprint could not be checked right now — open its print view again");
    throw e;
  }
}

export const markPrintedSchema = z.object({ deviceId: z.string().optional() }).optional();

/**
 * The operator's explicit "Mark as printed" confirmation (never inferred from the print dialog, a CSV download or
 * navigation): GENERATED lots of the order and their packs become PRINTED, one PRINTED movement per lot, and the
 * order gets its printedAt — all in one transaction. Repeating it changes nothing.
 *
 * `{ lotType }` confirms one print run only (cases and trays are printed on separate label rolls): only that run's
 * lots become PRINTED, and the order becomes PRINTED once no lot of any run is waiting. Without it, every run.
 */
export const markPrintedSchema = z.object({ lotType: z.enum(LOT_TYPES).optional() });

const runLabel = (t: LotType) => (t === "CASE" ? "case" : "tray");

export async function markPrinted(userId: string | null, printOrderId: string, body: unknown = {}) {
  const { lotType } = markPrintedSchema.parse(body ?? {});
 * Bulk writes (one statement for the lots, one for their packs, one batch of movements), so a 5,000-lot order
 * is confirmed in about a second instead of one round trip per lot and pack. The PRINTED movements keep the
 * order's PC; when the confirmation comes from another PC of the plant, that PC is named in the note.
 */
export async function markPrinted(userId: string | null, printOrderId: string, body?: unknown) {
  const input = markPrintedSchema.parse(body ?? undefined);
  return getStore().transaction(async (tx) => {
    const actor = await loadActor(tx, userId);
    requireAction(actor, "printOrder");
    const order = await requireOwnOrder(tx, actor, printOrderId);
    const confirmingPc = input?.deviceId ? await printDevice(tx, order.manufacturerId, input.deviceId) : null;
    const at = nowIso();
    const lots = await tx.lots.list({ printOrderId });
    const run = lotType ? lots.filter((l) => l.lotType === lotType) : lots;
    if (lotType && !run.length) throw badRequest("NOTHING_TO_PRINT", `This print order has no ${runLabel(lotType)}s`);
    if (order.status !== "PRINTED" && !run.some((l) => l.status === "GENERATED")) {
      // This run was already confirmed: repeating it changes nothing.
      if (lotType && run.some((l) => l.status !== "VOID")) return { printOrder: order, lotsPrinted: 0 };
    const pending = await tx.lots.list({ printOrderId, status: "GENERATED" });
    if (order.status !== "PRINTED" && !pending.length) {
      // Every lot was voided (or is otherwise no longer waiting for stickers): nothing to confirm.
      const what = lotType ? `${runLabel(lotType)} lot` : "lot";
      throw badRequest("NOTHING_TO_PRINT", `No ${what} of this print order is waiting to be printed (voided lots cannot be marked as printed)`);
    }
    let changed = 0;
    for (const lot of run.filter((l) => l.status === "GENERATED")) {
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
    if (pending.length) {
      const lotCodes = pending.map((l) => l.lotCode);
      await tx.lots.updateWhere({ printOrderId, status: "GENERATED" }, { status: "PRINTED", updatedAt: at });
      await tx.packs.updateWhere({ lotCode: lotCodes, status: "GENERATED" }, { status: "PRINTED", updatedAt: at });
      const note = confirmingPc && confirmingPc.id !== order.deviceId ? `Confirmed on ${confirmingPc.name}` : null;
      await tx.appendMovements(
        pending.map((lot) => ({
          type: "PRINTED" as const,
          itemKind: "LOT" as const,
          itemCode: lot.lotCode,
          fromId: lot.locationId,
          toId: lot.locationId,
          fromStatus: "GENERATED" as const,
          toStatus: "PRINTED" as const,
          userId: actor.user.id,
          deviceId: order.deviceId,
          invoice: null,
          note,
          at,
        })),
      );
    }
    // Lots of the other run still waiting: the order stays pending until that run is confirmed too.
    if (lots.some((l) => l.status === "GENERATED" && !run.includes(l))) return { printOrder: order, lotsPrinted: changed };
    const updated = await tx.printOrders.update(order.id, { status: "PRINTED", printedAt: order.printedAt ?? at });
    return { printOrder: updated, lotsPrinted: pending.length };
  });
}
