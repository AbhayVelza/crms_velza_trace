// Sticker geometry (mm). Pure so the barcode print specs can be unit tested:
// narrow bar (X) ≥ 0.25 mm, bar height ≥ 12 mm, 2.5 mm clear margin each side, QR ≥ 20 mm
// (plus a white quiet zone around the QR so phone scanners lock on).

export const SPEC = {
  minModuleMm: 0.25,
  maxModuleMm: 0.5,
  minBarHeightMm: 12,
  maxBarHeightMm: 20,
  quietZoneMm: 2.5,
  minQrMm: 20,
  maxQrMm: 28,
  qrQuietMm: 3,
};

export interface Box {
  widthMm: number;
  heightMm: number;
}

export interface BarcodeGeometry {
  moduleMm: number;
  widthMm: number; // bars only, quiet zones excluded
  heightMm: number;
}

export interface LayoutResult {
  padMm: number;
  headerMm: number;
  headerFontMm: number;
  textMm: number;
  textFontMm: number;
  barcode: BarcodeGeometry;
  qrMm: number | null; // QR symbol size, quiet zone excluded
  warnings: string[];
}

function barcodeFit(availWidthMm: number, availHeightMm: number, modules: number): { geom: BarcodeGeometry; warnings: string[] } {
  const warnings: string[] = [];
  const fitModule = availWidthMm / modules;
  const moduleMm = Math.min(SPEC.maxModuleMm, Math.max(SPEC.minModuleMm, Math.floor(fitModule * 1000) / 1000));
  if (fitModule < SPEC.minModuleMm) warnings.push(`Sticker too narrow: bars need ${(modules * SPEC.minModuleMm + 2 * SPEC.quietZoneMm).toFixed(1)} mm`);
  const heightMm = Math.min(SPEC.maxBarHeightMm, availHeightMm);
  if (heightMm < SPEC.minBarHeightMm) warnings.push(`Sticker too short: bar height ${heightMm.toFixed(1)} mm < ${SPEC.minBarHeightMm} mm`);
  return { geom: { moduleMm, widthMm: modules * moduleMm, heightMm: Math.max(heightMm, SPEC.minBarHeightMm) }, warnings };
}

/** Lot sticker: header line on top, QR left, barcode + large code text right. */
export function lotStickerLayout(size: Box, modules: number): LayoutResult {
  const padMm = 2;
  const headerFontMm = 3.2;
  const headerMm = 5;
  const textFontMm = 4.2;
  const textMm = 6;
  const gapMm = 2;
  const bodyMm = size.heightMm - 2 * padMm - headerMm;
  const qrMm = Math.max(SPEC.minQrMm, Math.min(SPEC.maxQrMm, bodyMm - 2 * SPEC.qrQuietMm, size.widthMm * 0.3));
  const colMm = size.widthMm - 2 * padMm - qrMm - 2 * SPEC.qrQuietMm - gapMm;
  const { geom, warnings } = barcodeFit(colMm - 2 * SPEC.quietZoneMm, bodyMm - textMm, modules);
  if (bodyMm < SPEC.minQrMm + 2 * SPEC.qrQuietMm) warnings.push(`Sticker too short for a ${SPEC.minQrMm} mm QR code with its quiet zone`);
  return { padMm, headerMm, headerFontMm, textMm, textFontMm, barcode: geom, qrMm, warnings };
}

/** Pack sticker: header line, barcode, code text. */
export function packStickerLayout(size: Box, modules: number): LayoutResult {
  const padMm = 1.5;
  const headerFontMm = 2.9;
  const headerMm = 4;
  const textFontMm = 3;
  const textMm = 3.8;
  const { geom, warnings } = barcodeFit(size.widthMm - 2 * padMm - 2 * SPEC.quietZoneMm, size.heightMm - 2 * padMm - headerMm - textMm, modules);
  return { padMm, headerMm, headerFontMm, textMm, textFontMm, barcode: geom, qrMm: null, warnings };
}

/** Module count of a bwip-js Code 128 SVG rendered at scale 1 (viewBox width = modules). */
export function modulesFromSvg(svg: string): number {
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
  if (!m) throw new Error("SVG has no viewBox");
  return Number(m[1]);
}
