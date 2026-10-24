// Print order planning: validates the wizard input and computes the summary
// (batch codes from the pool, lot ranges, sticker counts) without side effects.

import { allocateLots, LOT_NUMBER_MAX, stickerCount, type AllocatedLot } from "./codes";

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
  lots: AllocatedLot[];
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
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const range = (lots: AllocatedLot[]): [string, string] | null =>
  lots.length ? [lots[0].lotHex, lots[lots.length - 1].lotHex] : null;

export function planPrintOrder({ batches, country, poolCodes, flavours, maxBatches = 20 }: PlanInput): PrintOrderPlan {
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

  const planned: PlannedBatch[] = batches.map((b, i) => {
    const label = `Batch ${i + 1}`;
    if (!flavours.includes(b.flavour)) errors.push({ batchIndex: i, field: "flavour", message: `${label}: choose a flavour` });
    const mfgOk = isValidDate(b.mfgDate);
    const expOk = isValidDate(b.expiryDate);
    if (!mfgOk) errors.push({ batchIndex: i, field: "mfgDate", message: `${label}: manufacture date is missing or invalid` });
    if (!expOk) errors.push({ batchIndex: i, field: "expiryDate", message: `${label}: expiry date is missing or invalid` });
    if (mfgOk && expOk && b.expiryDate <= b.mfgDate) {
      errors.push({ batchIndex: i, field: "expiryDate", message: `${label}: expiry date must be after manufacture date` });
    }
    const countsOk = [b.cases, b.trays].every((n) => Number.isInteger(n) && n >= 0);
    if (!countsOk) errors.push({ batchIndex: i, field: "cases", message: `${label}: cases and trays must be whole numbers ≥ 0` });
    else if (b.cases + b.trays === 0) {
      errors.push({ batchIndex: i, field: "cases", message: `${label}: enter at least 1 case or 1 tray (both are 0)` });
    } else if (b.cases + b.trays > LOT_NUMBER_MAX) {
      errors.push({ batchIndex: i, field: "cases", message: `${label}: at most ${LOT_NUMBER_MAX} lots per batch` });
    }

    const batchCode = poolCodes[i] ?? null;
    let lots: AllocatedLot[] = [];
    if (countsOk && b.cases + b.trays > 0 && b.cases + b.trays <= LOT_NUMBER_MAX && flavours.includes(b.flavour)) {
      // Preview codes use a placeholder batch code when the pool is short; they are never saved.
      lots = allocateLots({ code: batchCode ?? "XXXXXX", country, flavour: b.flavour, nextLot: 1 }, b.cases, b.trays).lots;
    }
    const caseLots = lots.filter((l) => l.lotType === "CASE");
    const trayLots = lots.filter((l) => l.lotType === "TRAY");
    return {
      index: i,
      batchCode,
      flavour: b.flavour,
      mfgDate: b.mfgDate,
      expiryDate: b.expiryDate,
      cases: b.cases,
      trays: b.trays,
      lots,
      caseRange: range(caseLots),
      trayRange: range(trayLots),
      lotRange: range(lots),
      stickerCount: countsOk ? stickerCount(b.cases, b.trays) : 0,
    };
  });

  return {
    ok: errors.length === 0,
    batches: planned,
    totalLots: planned.reduce((s, b) => s + b.lots.length, 0),
    totalStickers: planned.reduce((s, b) => s + b.stickerCount, 0),
    errors,
  };
}
