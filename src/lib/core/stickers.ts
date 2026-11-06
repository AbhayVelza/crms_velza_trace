// Sticker content and print order: lot sticker first, then its pack stickers, lot by lot. Cases and trays are
// printed as separate runs on separate label rolls, so every sticker carries its lot type.

import { buildPackCodes, CANS_PER_LOT, PACK_SIZE, PACKS_PER_LOT } from "./codes";
import type { LotType } from "./types";

export interface LotSticker {
  kind: "LOT";
  lotType: LotType;
  code: string;
  header: string;
}

export interface PackSticker {
  kind: "PACK";
  lotType: LotType;
  code: string;
  header: string;
}

export type Sticker = LotSticker | PackSticker;

export function lotStickerHeader(lotType: LotType, flavourName: string): string {
  return `${lotType} | ${flavourName.toUpperCase()} | ${PACKS_PER_LOT[lotType]} x ${PACK_SIZE[lotType]} = ${CANS_PER_LOT} CANS`;
}

export function packStickerHeader(lotType: LotType, seq: number): string {
  return `PACK ${seq} of ${PACKS_PER_LOT[lotType]} | ${PACK_SIZE[lotType]} CANS`;
}

export interface StickerLot {
  lotCode: string;
  lotType: LotType;
  flavourName: string;
}

/** Lot (case or tray) sticker: barcode only, no QR code. */
export function lotSticker(lot: StickerLot): LotSticker {
  return { kind: "LOT", lotType: lot.lotType, code: lot.lotCode, header: lotStickerHeader(lot.lotType, lot.flavourName) };
}

export function stickersForLot(lot: StickerLot): Sticker[] {
  const packs: PackSticker[] = buildPackCodes(lot.lotCode, lot.lotType).map((code, i) => ({
    kind: "PACK",
    lotType: lot.lotType,
    code,
    header: packStickerHeader(lot.lotType, i + 1),
  }));
  return [lotSticker(lot), ...packs];
}

export function stickersForLots(lots: StickerLot[]): Sticker[] {
  return lots.flatMap((l) => stickersForLot(l));
}

/** Single sticker for a reprint: same code, same content. */
export function stickerForCode(code: string, lot: StickerLot): Sticker | null {
  return stickersForLot(lot).find((s) => s.code === code) ?? null;
}
