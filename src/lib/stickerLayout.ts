// Sticker geometry (mm), shared by the on-screen/print preview and the PDF so both come out identical.
// Pure so the print specs can be unit tested. Default sizes: case/tray 70 × 25 mm, pack 45 × 15 mm.
//
// Both stickers: header line, Code 128 barcode, code text (no QR code). The case/tray barcode is bigger.
//
// The bars are as wide as the sticker allows, with a quiet zone of 10 bars each side (Code 128). At the default
// sizes the narrow bar is about 0.32 mm on a case/tray and 0.20 mm on a pack: below 0.25 mm it needs a
// 300 dpi (or finer) label printer, so the print view says so.

export const SPEC = {
  /** Narrowest bar that still scans: 2 dots on a 300 dpi printer. */
  minModuleMm: 0.17,
  /** Below this a 203 dpi printer can't draw the bars evenly. */
  dpi203ModuleMm: 0.25,
  maxModuleMm: 0.33,
  lotMaxModuleMm: 0.4,
  minBarHeightMm: 6,
  maxBarHeightMm: 20,
  lotMaxBarHeightMm: 18,
  /** Code 128 quiet zone: 10 narrow bars each side. */
  quietModules: 10,
};

/** Text width per character, as a fraction of the font size (bold capitals, monospace, regular). */
const CHAR_EM = { bold: 0.68, mono: 0.62 };

export interface Box {
  widthMm: number;
  heightMm: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextBox extends Rect {
  fontMm: number;
}

export interface BarcodeBox extends Rect {
  moduleMm: number;
  /** Quiet zone each side of the bars. */
  quietMm: number;
}

export interface StickerLayout {
  header: TextBox;
  barcode: BarcodeBox;
  /** The code in plain text, under the bars. */
  text: TextBox;
  warnings: string[];
}

export interface StickerContent {
  header: string;
  code: string;
  /** Code 128 modules of the code (bwip-js). */
  modules: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const floor3 = (n: number) => Math.floor(n * 1000) / 1000;

/** Largest font (up to maxFontMm) that fits `text` in `widthMm`. */
function fitFont(text: string, widthMm: number, maxFontMm: number, em: number): number {
  return Math.min(maxFontMm, widthMm / Math.max(1, text.length * em));
}

/** Bars + quiet zones as wide as `availW` allows (capped), as tall as `availH` allows (capped). */
function fitBars(modules: number, availW: number, availH: number, maxModuleMm: number, maxBarHeightMm: number, warnings: string[]) {
  const fit = availW / (modules + 2 * SPEC.quietModules);
  if (fit < SPEC.minModuleMm) warnings.push(`Sticker too narrow: the barcode needs ${((modules + 2 * SPEC.quietModules) * SPEC.minModuleMm).toFixed(1)} mm`);
  const moduleMm = clamp(floor3(fit), SPEC.minModuleMm, maxModuleMm);
  const heightMm = Math.min(maxBarHeightMm, availH);
  if (heightMm < SPEC.minBarHeightMm) warnings.push(`Sticker too short: bar height ${heightMm.toFixed(1)} mm < ${SPEC.minBarHeightMm} mm`);
  return { moduleMm, quietMm: moduleMm * SPEC.quietModules, w: modules * moduleMm, h: Math.max(heightMm, SPEC.minBarHeightMm) };
}

/** Case/tray sticker: header, barcode, code text — like a pack sticker, with bigger bars. */
export function lotStickerLayout(size: Box, c: StickerContent): StickerLayout {
  return stack(size, c, clamp(size.heightMm * 0.06, 1, 3), 0.72, (_H, bodyH) => bodyH * 0.24, SPEC.lotMaxModuleMm, SPEC.lotMaxBarHeightMm);
}

/** Pack sticker: header, barcode, code text. */
export function packStickerLayout(size: Box, c: StickerContent): StickerLayout {
  return stack(size, c, clamp(size.heightMm * 0.05, 0.6, 2), 0.75, (H) => H * 0.18, SPEC.maxModuleMm, SPEC.maxBarHeightMm);
}

/** Header on top, then the bars and the code text centred in the space left. */
function stack(size: Box, c: StickerContent, pad: number, headerFont: number, textHeight: (H: number, bodyH: number) => number, maxModuleMm: number, maxBarHeightMm: number): StickerLayout {
  const W = size.widthMm;
  const H = size.heightMm;
  const warnings: string[] = [];
  const headerH = H * 0.18;
  const header: TextBox = { x: pad, y: pad, w: W - 2 * pad, h: headerH, fontMm: fitFont(c.header, W - 2 * pad, headerH * headerFont, CHAR_EM.bold) };
  const bodyY = pad + headerH;
  const bodyH = H - bodyY - pad;
  const textH = textHeight(H, bodyH);
  const bars = fitBars(c.modules, W - 2 * pad, bodyH - textH, maxModuleMm, maxBarHeightMm, warnings);
  const blockTop = bodyY + Math.max(0, (bodyH - bars.h - textH) / 2);
  const barcode: BarcodeBox = { x: (W - bars.w) / 2, y: blockTop, w: bars.w, h: bars.h, moduleMm: bars.moduleMm, quietMm: bars.quietMm };
  const text: TextBox = { x: pad, y: blockTop + bars.h, w: W - 2 * pad, h: textH, fontMm: fitFont(c.code, bars.w, textH * 0.85, CHAR_EM.mono) };
  return { header, barcode, text, warnings };
}

/** Module count of a bwip-js Code 128 SVG rendered at scale 1 (viewBox width = modules). */
export function modulesFromSvg(svg: string): number {
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /);
  if (!m) throw new Error("SVG has no viewBox");
  return Number(m[1]);
}
