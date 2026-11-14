// Everything needed to draw one sticker: its size, layout and Code 128 bar widths.
// The on-screen/print view and the PDF both draw from this, so they match exactly.

import { code128Widths } from "./barcode";
import type { Sticker } from "./core/stickers";
import { lotStickerLayout, packStickerLayout, type Box, type StickerLayout } from "./stickerLayout";

export interface DrawnSticker {
  sticker: Sticker;
  size: Box;
  layout: StickerLayout;
  /** Bar/space widths in modules, starting with a bar. */
  bars: number[];
}

export function drawSticker(sticker: Sticker, lotSize: Box, packSize: Box): DrawnSticker {
  const bars = code128Widths(sticker.code);
  const modules = bars.reduce((a, b) => a + b, 0);
  const content = { header: sticker.header, code: sticker.code, modules };
  if (sticker.kind === "LOT") return { sticker, size: lotSize, layout: lotStickerLayout(lotSize, content), bars };
  return { sticker, size: packSize, layout: packStickerLayout(packSize, content), bars };
}

/** Bars as rectangles in module units: [x, width] of each dark bar. */
export function barRuns(bars: number[]): [number, number][] {
  const out: [number, number][] = [];
  let x = 0;
  bars.forEach((w, i) => {
    if (i % 2 === 0) out.push([x, w]);
    x += w;
  });
  return out;
}

/** SVG of the bars, stretched to its box. */
export function barsSvg(bars: number[]): string {
  const modules = bars.reduce((a, b) => a + b, 0);
  const rects = barRuns(bars)
    .map(([x, w]) => `<rect x="${x}" y="0" width="${w}" height="1"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${modules} 1" preserveAspectRatio="none" shape-rendering="crispEdges"><g fill="#000">${rects}</g></svg>`;
}

/** Narrowest bar across the stickers (mm), for the printer-resolution note. */
export function narrowestBarMm(drawn: DrawnSticker[]): number | null {
  return drawn.length ? Math.min(...drawn.map((d) => d.layout.barcode.moduleMm)) : null;
}
