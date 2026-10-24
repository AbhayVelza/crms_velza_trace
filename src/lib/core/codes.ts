// Code generation and parsing. Pure functions; the only place codes are built.
//
// Lot code  (15): CC BBBBBB FF XXXXX        e.g. 91ABC123OR00001
// Pack code (17): lot code + pack size + seq e.g. 91ABC123OR0000161

import type { LotType, PackSize } from "./types";

export const LOT_CODE_LENGTH = 15;
export const PACK_CODE_LENGTH = 17;
export const LOT_NUMBER_MIN = 1;
export const LOT_NUMBER_MAX = 0x1869f; // 99,999
export const BATCH_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const DEFAULT_COUNTRIES = ["91"];
export const DEFAULT_FLAVOURS = ["OR", "GA", "NS", "MN"];

export const PACK_SIZE: Record<LotType, PackSize> = { CASE: 6, TRAY: 4 };
export const PACKS_PER_LOT: Record<LotType, number> = { CASE: 4, TRAY: 6 };
export const CANS_PER_LOT = 24;

const COUNTRY_RE = /^[0-9]{2}$/;
const BATCH_RE = /^[A-Z0-9]{6}$/;
const FLAVOUR_RE = /^[A-Z]{2}$/;
const LOT_HEX_RE = /^[0-9A-F]{5}$/;

export function lotTypeForPackSize(size: number): LotType | null {
  if (size === 6) return "CASE";
  if (size === 4) return "TRAY";
  return null;
}

/** Stickers printed per lot: 1 lot sticker + one per pack. */
export function stickersPerLot(lotType: LotType): number {
  return 1 + PACKS_PER_LOT[lotType];
}

export function stickerCount(cases: number, trays: number): number {
  return cases * stickersPerLot("CASE") + trays * stickersPerLot("TRAY");
}

// ---------------------------------------------------------------- batch codes

export type RandomBytes = (n: number) => Uint8Array;

const cryptoRandomBytes: RandomBytes = (n) => {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
};

/**
 * Crypto-random 6-char [A-Z0-9] batch code not present in `existing`.
 * Rejection sampling keeps the 36 characters uniformly likely.
 */
export function generateBatchCode(existing: Set<string>, randomBytes: RandomBytes = cryptoRandomBytes): string {
  const limit = 252; // largest multiple of 36 below 256
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    while (code.length < 6) {
      for (const b of randomBytes(12)) {
        if (b < limit) code += BATCH_CODE_CHARS[b % 36];
        if (code.length === 6) break;
      }
    }
    if (!existing.has(code)) return code;
  }
  throw new Error("Could not generate a unique batch code after 1000 attempts");
}

// ---------------------------------------------------------------- lot numbers

export function formatLotNumber(n: number): string {
  if (!Number.isInteger(n) || n < LOT_NUMBER_MIN || n > LOT_NUMBER_MAX) {
    throw new RangeError(`Lot number must be an integer from 1 to ${LOT_NUMBER_MAX} (got ${n})`);
  }
  return n.toString(16).toUpperCase().padStart(5, "0");
}

export function parseLotNumber(hex: string): number {
  if (!LOT_HEX_RE.test(hex)) {
    throw new RangeError(`Lot number must be exactly 5 uppercase hex characters (got "${hex}")`);
  }
  const n = parseInt(hex, 16);
  if (n < LOT_NUMBER_MIN) throw new RangeError("Lot number 00000 is reserved");
  if (n > LOT_NUMBER_MAX) throw new RangeError(`Lot number ${hex} is above the maximum 1869F`);
  return n;
}

// ---------------------------------------------------------------- build

export interface LotCodeParts {
  country: string;
  batch: string;
  flavour: string;
  lotNumber: number;
}

export function buildLotCode({ country, batch, flavour, lotNumber }: LotCodeParts): string {
  if (!COUNTRY_RE.test(country)) throw new Error(`Invalid country code "${country}"`);
  if (!BATCH_RE.test(batch)) throw new Error(`Invalid batch code "${batch}"`);
  if (!FLAVOUR_RE.test(flavour)) throw new Error(`Invalid flavour code "${flavour}"`);
  return `${country}${batch}${flavour}${formatLotNumber(lotNumber)}`;
}

export function buildPackCodes(lotCode: string, lotType: LotType): string[] {
  const parsed = parseCode(lotCode, { countries: null, flavours: null });
  if (!parsed.ok || parsed.value.kind !== "LOT") throw new Error(`Invalid lot code "${lotCode}"`);
  const size = PACK_SIZE[lotType];
  return Array.from({ length: PACKS_PER_LOT[lotType] }, (_, i) => `${lotCode}${size}${i + 1}`);
}

// ---------------------------------------------------------------- parse

export type CodeErrorCode =
  | "EMPTY"
  | "BAD_LENGTH"
  | "BAD_COUNTRY"
  | "BAD_BATCH"
  | "BAD_FLAVOUR"
  | "BAD_LOT_NUMBER"
  | "BAD_PACK_SIZE"
  | "BAD_PACK_SEQ";

export interface CodeError {
  code: CodeErrorCode;
  message: string;
}

export interface ParsedCode {
  kind: "LOT" | "PACK";
  country: string;
  batch: string;
  flavour: string;
  lotHex: string;
  lotNumber: number;
  lotCode: string;
  packSize?: PackSize;
  packSeq?: number;
}

export type ParseResult = { ok: true; value: ParsedCode } | { ok: false; error: CodeError };

export interface ParseOptions {
  /** Allowed country codes; null = any 2 digits. */
  countries?: string[] | null;
  /** Allowed flavour codes; null = any 2 uppercase letters. */
  flavours?: string[] | null;
}

function fail(code: CodeErrorCode, message: string): ParseResult {
  return { ok: false, error: { code, message } };
}

export function parseCode(code: string, opts: ParseOptions = {}): ParseResult {
  const countries = opts.countries === undefined ? DEFAULT_COUNTRIES : opts.countries;
  const flavours = opts.flavours === undefined ? DEFAULT_FLAVOURS : opts.flavours;

  if (!code) return fail("EMPTY", "Empty code");
  if (code.length !== LOT_CODE_LENGTH && code.length !== PACK_CODE_LENGTH) {
    return fail("BAD_LENGTH", `Code must be 15 (lot) or 17 (pack) characters, got ${code.length}`);
  }
  const country = code.slice(0, 2);
  const batch = code.slice(2, 8);
  const flavour = code.slice(8, 10);
  const lotHex = code.slice(10, 15);

  if (!COUNTRY_RE.test(country) || (countries && !countries.includes(country))) {
    return fail("BAD_COUNTRY", `Unknown country code "${country}"`);
  }
  if (!BATCH_RE.test(batch)) return fail("BAD_BATCH", `Invalid batch code "${batch}"`);
  if (!FLAVOUR_RE.test(flavour) || (flavours && !flavours.includes(flavour))) {
    return fail("BAD_FLAVOUR", `Unknown flavour code "${flavour}"`);
  }
  let lotNumber: number;
  try {
    lotNumber = parseLotNumber(lotHex);
  } catch (e) {
    return fail("BAD_LOT_NUMBER", (e as Error).message);
  }
  const lotCode = code.slice(0, 15);
  if (code.length === LOT_CODE_LENGTH) {
    return { ok: true, value: { kind: "LOT", country, batch, flavour, lotHex, lotNumber, lotCode } };
  }

  const sizeCh = code[15];
  const seqCh = code[16];
  if (sizeCh !== "4" && sizeCh !== "6") return fail("BAD_PACK_SIZE", `Pack size must be 4 or 6, got "${sizeCh}"`);
  const packSize = Number(sizeCh) as PackSize;
  const maxSeq = packSize === 6 ? 4 : 6;
  if (!/^[1-9]$/.test(seqCh) || Number(seqCh) > maxSeq) {
    return fail("BAD_PACK_SEQ", `Pack sequence for size ${packSize} must be 1–${maxSeq}, got "${seqCh}"`);
  }
  return {
    ok: true,
    value: { kind: "PACK", country, batch, flavour, lotHex, lotNumber, lotCode, packSize, packSeq: Number(seqCh) },
  };
}

/**
 * Normalise raw scanner input. QR codes carry a URL like https://host/t/<code>;
 * the code is the last path segment. Codes are never edited otherwise.
 */
export function extractScannedCode(raw: string): string {
  const s = raw.trim();
  if (!s.includes("/")) return s;
  const withoutQuery = s.split(/[?#]/)[0];
  const segments = withoutQuery.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// ---------------------------------------------------------------- allocation

export interface BatchForAllocation {
  code: string;
  country: string;
  flavour: string;
  nextLot: number;
}

export interface AllocatedLot {
  lotNumber: number;
  lotHex: string;
  lotCode: string;
  lotType: LotType;
  packSize: PackSize;
  packCodes: string[];
}

export interface Allocation {
  lots: AllocatedLot[];
  nextLot: number;
}

/** Cases first, then trays, consecutive numbers from the batch's next counter. */
export function allocateLots(batch: BatchForAllocation, cases: number, trays: number): Allocation {
  for (const [name, n] of [
    ["cases", cases],
    ["trays", trays],
  ] as const) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`${name} must be a whole number ≥ 0 (got ${n})`);
  }
  if (!Number.isInteger(batch.nextLot) || batch.nextLot < LOT_NUMBER_MIN) {
    throw new RangeError(`Batch next lot counter is invalid (${batch.nextLot})`);
  }
  const total = cases + trays;
  const last = batch.nextLot + total - 1;
  if (total > 0 && last > LOT_NUMBER_MAX) {
    throw new RangeError(
      `Batch ${batch.code} would exceed the lot limit 1869F (${LOT_NUMBER_MAX} lots); requested ${total} from ${formatLotNumber(batch.nextLot)}`,
    );
  }
  const lots: AllocatedLot[] = [];
  let n = batch.nextLot;
  const push = (lotType: LotType) => {
    const lotCode = buildLotCode({ country: batch.country, batch: batch.code, flavour: batch.flavour, lotNumber: n });
    lots.push({
      lotNumber: n,
      lotHex: formatLotNumber(n),
      lotCode,
      lotType,
      packSize: PACK_SIZE[lotType],
      packCodes: buildPackCodes(lotCode, lotType),
    });
    n++;
  };
  for (let i = 0; i < cases; i++) push("CASE");
  for (let i = 0; i < trays; i++) push("TRAY");
  return { lots, nextLot: n };
}
