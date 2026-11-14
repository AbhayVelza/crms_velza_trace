// Sticker geometry (mm). Pure so the barcode print specs can be unit tested:
// narrow bar (X) ≥ 0.25 mm, bar height ≥ 12 mm, 2.5 mm clear margin each side. Stickers carry a Code 128
// barcode only (no QR). The lot (case/tray) barcode is a little bigger than the pack one: its bars may grow to
// 0.4 mm × 18 mm, against about 0.3 mm × 14 mm for a pack at the default sizes.

export const SPEC = {
  minModuleMm: 0.25,
  maxModuleMm: 0.5,
  minBarHeightMm: 12,
  maxBarHeightMm: 20,
  quietZoneMm: 2.5,
  lotMaxModuleMm: 0.4,
  lotMaxBarHeightMm: 18,
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
  warnings: string[];
}

function barcodeFit(
  availWidthMm: number,
  availHeightMm: number,
  modules: number,
  maxModuleMm = SPEC.maxModuleMm,
  maxBarHeightMm = SPEC.maxBarHeightMm,
): { geom: BarcodeGeometry; warnings: string[] } {
  const warnings: string[] = [];
  const fitModule = availWidthMm / modules;
  const moduleMm = Math.min(maxModuleMm, Math.max(SPEC.minModuleMm, Math.floor(fitModule * 1000) / 1000));
  if (fitModule < SPEC.minModuleMm) warnings.push(`Sticker too narrow: bars need ${(modules * SPEC.minModuleMm + 2 * SPEC.quietZoneMm).toFixed(1)} mm`);
  const heightMm = Math.min(maxBarHeightMm, availHeightMm);
  if (heightMm < SPEC.minBarHeightMm) warnings.push(`Sticker too short: bar height ${heightMm.toFixed(1)} mm < ${SPEC.minBarHeightMm} mm`);
  return { geom: { moduleMm, widthMm: modules * moduleMm, heightMm: Math.max(heightMm, SPEC.minBarHeightMm) }, warnings };
}

/** Lot (case/tray) sticker: header line, barcode, large code text — like a pack sticker, with bigger bars. */
export function lotStickerLayout(size: Box, modules: number): LayoutResult {
  const padMm = 2;
  const headerFontMm = 3.2;
  const headerMm = 5;
  const textFontMm = 4.2;
  const textMm = 6;
  const { geom, warnings } = barcodeFit(
    size.widthMm - 2 * padMm - 2 * SPEC.quietZoneMm,
    size.heightMm - 2 * padMm - headerMm - textMm,
    modules,
    SPEC.lotMaxModuleMm,
    SPEC.lotMaxBarHeightMm,
  );
  return { padMm, headerMm, headerFontMm, textMm, textFontMm, barcode: geom, warnings };
}

/** Pack sticker: header line, barcode, code text. */
export function packStickerLayout(size: Box, modules: number): LayoutResult {
  const padMm = 1.5;
  const headerFontMm = 2.9;
  const headerMm = 4;
  const textFontMm = 3;
  const textMm = 3.8;
  const { geom, warnings } = barcodeFit(size.widthMm - 2 * padMm - 2 * SPEC.quietZoneMm, size.heightMm - 2 * padMm - headerMm - textMm, modules);
  return { padMm, headerMm, headerFontMm, textMm, textFontMm, barcode: geom, warnings };
}

/** Module count of a bwip-js Code 128 SVG rendered at scale 1 (viewBox width = modules). */
export function modulesFromSvg(svg: string): number {
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
  if (!m) throw new Error("SVG has no viewBox");
  return Number(m[1]);
}
