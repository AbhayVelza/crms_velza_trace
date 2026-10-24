// Sticker content and print order: lot sticker first, then its pack stickers, lot by lot.

import { buildPackCodes, CANS_PER_LOT, PACK_SIZE, PACKS_PER_LOT } from "./codes";
import type { LotType } from "./types";

export interface LotSticker {
  kind: "LOT";
  code: string;
  header: string;
  qrUrl: string;
}

export interface PackSticker {
  kind: "PACK";
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

export function qrUrlFor(publicBaseUrl: string, lotCode: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/t/${lotCode}`;
}

export interface StickerLot {
  lotCode: string;
  lotType: LotType;
  flavourName: string;
}

export function lotSticker(lot: StickerLot, publicBaseUrl: string): LotSticker {
  return { kind: "LOT", code: lot.lotCode, header: lotStickerHeader(lot.lotType, lot.flavourName), qrUrl: qrUrlFor(publicBaseUrl, lot.lotCode) };
}

export function stickersForLot(lot: StickerLot, publicBaseUrl: string): Sticker[] {
  const packs: PackSticker[] = buildPackCodes(lot.lotCode, lot.lotType).map((code, i) => ({
    kind: "PACK",
    code,
    header: packStickerHeader(lot.lotType, i + 1),
  }));
  return [lotSticker(lot, publicBaseUrl), ...packs];
}

export function stickersForLots(lots: StickerLot[], publicBaseUrl: string): Sticker[] {
  return lots.flatMap((l) => stickersForLot(l, publicBaseUrl));
}

/** Single sticker for a reprint: same code, same content. */
export function stickerForCode(code: string, lot: StickerLot, publicBaseUrl: string): Sticker | null {
  return stickersForLot(lot, publicBaseUrl).find((s) => s.code === code) ?? null;
}
