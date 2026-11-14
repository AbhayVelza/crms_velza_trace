// Print order planning: validates the wizard input and computes the summary
// (batch codes from the pool, lot ranges, sticker counts) without side effects.

import { allocateLots, formatLotNumber, LOT_NUMBER_MAX, stickerCount, type AllocatedLot } from "./codes";

export interface BatchInput {
  flavour: string;
  mfgDate: string;
  expiryDate: string;
  cases: number;
  trays: number;
}

export interface PlanError {
  batchIndex: number | null;
  field: keyof BatchInput | "batchCode" | "batches" | null;
  message: string;
}

export interface PlannedBatch {
  index: number;
  batchCode: string | null;
  flavour: string;
  mfgDate: string;
  expiryDate: string;
  cases: number;
  trays: number;
  /** Every code of the batch (preview only; empty when the order is over the lot cap). Never sent to the browser. */
  lots: AllocatedLot[];
  /** Lots this batch will get (cases + trays when valid, else 0). */
  lotCount: number;
  caseRange: [string, string] | null;
  trayRange: [string, string] | null;
  lotRange: [string, string] | null;
  stickerCount: number;
}

export interface PrintOrderPlan {
  ok: boolean;
  batches: PlannedBatch[];
  totalLots: number;
  totalStickers: number;
  errors: PlanError[];
}

export interface PlanInput {
  batches: BatchInput[];
  country: string;
  /** RESERVED pool codes for the device, in issue order. */
  poolCodes: string[];
  /** Active flavour codes. */
  flavours: string[];
  maxBatches?: number;
  /** Lots one print order may hold on this server's store (refused above it, never truncated). */
  maxLotsPerOrder?: number;
  /** Said after the lot cap, e.g. " on the JSON file store". */
  maxLotsNote?: string;
  /** Today (YYYY-MM-DD, server clock). When given, a manufacture date in the future is refused. */
  today?: string;
}

/** A manufacture date may be up to this many days ahead of the server's date (time zones: India is UTC+5:30). */
export const MFG_FUTURE_TOLERANCE_DAYS = 1;
/** Longest shelf life accepted, in years after the manufacture date (catches a mistyped expiry year such as 2099). */
export const MAX_SHELF_LIFE_YEARS = 5;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const addYears = (iso: string, years: number) => `${String(Number(iso.slice(0, 4)) + years).padStart(4, "0")}${iso.slice(4)}`;

export function planPrintOrder({ batches, country, poolCodes, flavours, maxBatches = 20, maxLotsPerOrder, maxLotsNote = "", today }: PlanInput): PrintOrderPlan {
  const errors: PlanError[] = [];
  if (batches.length === 0) errors.push({ batchIndex: null, field: "batches", message: "Create at least one batch" });
  if (batches.length > maxBatches) {
    errors.push({ batchIndex: null, field: "batches", message: `At most ${maxBatches} batches per print order` });
  }
  if (poolCodes.length === 0 && batches.length > 0) {
    errors.push({ batchIndex: null, field: "batchCode", message: "Batch code pool is empty — ask Velza Admin to issue codes" });
  } else if (poolCodes.length < batches.length) {
    errors.push({
      batchIndex: null,
      field: "batchCode",
      message: `Batch code pool has only ${poolCodes.length} code(s) for ${batches.length} batches`,
    });
  }

  // The whole order is refused above the cap (never truncated): a big run is split into several orders.
  const lotsOf = (n: number) => (Number.isInteger(n) && n > 0 ? n : 0);
  const requested = batches.reduce((s, b) => s + lotsOf(b.cases) + lotsOf(b.trays), 0);
  const overCap = maxLotsPerOrder !== undefined && requested > maxLotsPerOrder;
  if (overCap) {
    errors.push({
      batchIndex: null,
      field: "batches",
      message: `At most ${maxLotsPerOrder.toLocaleString("en-IN")} lots per print order${maxLotsNote}; requested ${requested.toLocaleString("en-IN")} — split the run into several orders`,
    });
  }

  const planned: PlannedBatch[] = batches.map((b, i) => {
    const label = `Batch ${i + 1}`;
    if (!flavours.includes(b.flavour)) errors.push({ batchIndex: i, field: "flavour", message: `${label}: choose a flavour` });
    const mfgOk = isValidDate(b.mfgDate);
    const expOk = isValidDate(b.expiryDate);
    if (!mfgOk) errors.push({ batchIndex: i, field: "mfgDate", message: `${label}: manufacture date is missing or invalid` });
    if (!expOk) errors.push({ batchIndex: i, field: "expiryDate", message: `${label}: expiry date is missing or invalid` });
    if (mfgOk && today && b.mfgDate > addDays(today, MFG_FUTURE_TOLERANCE_DAYS)) {
      errors.push({ batchIndex: i, field: "mfgDate", message: `${label}: manufacture date ${b.mfgDate} is in the future (today is ${today})` });
    }
    if (mfgOk && expOk && b.expiryDate <= b.mfgDate) {
      errors.push({ batchIndex: i, field: "expiryDate", message: `${label}: expiry date must be after manufacture date` });
    } else if (mfgOk && expOk && b.expiryDate > addYears(b.mfgDate, MAX_SHELF_LIFE_YEARS)) {
      errors.push({ batchIndex: i, field: "expiryDate", message: `${label}: expiry date ${b.expiryDate} is more than ${MAX_SHELF_LIFE_YEARS} years after manufacture — check the year` });
    }
    const countsOk = [b.cases, b.trays].every((n) => Number.isInteger(n) && n >= 0);
    // Cases and trays are each 0 or a whole number, with no minimum: a batch may even be 0 + 0 (its code is taken
    // now and lots are added later with "Continue an existing batch"). Only a whole order with nothing to print is refused.
    if (!countsOk) errors.push({ batchIndex: i, field: "cases", message: `${label}: cases and trays must be 0 or a whole number` });
    else if (b.cases + b.trays > LOT_NUMBER_MAX) {
      errors.push({ batchIndex: i, field: "cases", message: `${label}: at most ${LOT_NUMBER_MAX} lots per batch` });
    }

    const batchCode = poolCodes[i] ?? null;
    let lots: AllocatedLot[] = [];
    const allocatable = countsOk && b.cases + b.trays > 0 && b.cases + b.trays <= LOT_NUMBER_MAX && flavours.includes(b.flavour);
    // Over the lot cap nothing is allocated, not even for the preview (ranges are worked out from the counts).
    if (allocatable && !overCap) {
      // Preview codes use a placeholder batch code when the pool is short; they are never saved.
      lots = allocateLots({ code: batchCode ?? "XXXXXX", country, flavour: b.flavour, nextLot: 1 }, b.cases, b.trays).lots;
    }
    const n = allocatable ? b.cases + b.trays : 0;
    const span = (from: number, to: number): [string, string] | null => (allocatable && to >= from ? [formatLotNumber(from), formatLotNumber(to)] : null);
    return {
      index: i,
      batchCode,
      flavour: b.flavour,
      mfgDate: b.mfgDate,
      expiryDate: b.expiryDate,
      cases: b.cases,
      trays: b.trays,
      lots,
      lotCount: n,
      caseRange: span(1, b.cases),
      trayRange: span(b.cases + 1, n),
      lotRange: span(1, n),
      stickerCount: countsOk ? stickerCount(b.cases, b.trays) : 0,
    };
  });

  const allCounted = batches.every((b) => [b.cases, b.trays].every((n) => Number.isInteger(n) && n >= 0));
  if (batches.length > 0 && allCounted && batches.every((b) => b.cases + b.trays === 0)) {
    errors.push({ batchIndex: null, field: "cases", message: "Nothing to print: every batch has 0 cases and 0 trays — enter cases or trays for at least one batch" });
  }

  return {
    ok: errors.length === 0,
    batches: planned,
    totalLots: planned.reduce((s, b) => s + b.lotCount, 0),
    totalStickers: planned.reduce((s, b) => s + b.stickerCount, 0),
    errors,
  };
}

/** One batch of the plan as the screen gets it: counts and ranges, with the first and last lot code, never every code. */
export type PlannedBatchSummary = Omit<PlannedBatch, "lots"> & { firstLotCode: string | null; lastLotCode: string | null };

/** The plan as the preview and create responses carry it: its size does not grow with the number of lots. */
export interface PrintOrderPlanSummary extends Omit<PrintOrderPlan, "batches"> {
  batches: PlannedBatchSummary[];
}

export function summarizePlan(plan: PrintOrderPlan): PrintOrderPlanSummary {
  return {
    ...plan,
    batches: plan.batches.map(({ lots, ...b }) => ({ ...b, firstLotCode: lots[0]?.lotCode ?? null, lastLotCode: lots[lots.length - 1]?.lotCode ?? null })),
  };
}
