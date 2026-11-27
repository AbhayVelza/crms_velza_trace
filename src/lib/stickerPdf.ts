// Stickers as a PDF, drawn in vectors (bars and text) so they print sharp at any printer resolution, with the
// same layout as the print view. Two formats:
// - label roll: one sticker per page, each page the sticker's real size;
// - case + packs: one page per case/tray: its sticker on top, its own pack stickers under it in two columns,
//   every sticker at real size with its outline drawn (case: 2 × 2 packs, tray: 3 × 2).

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { Sticker } from "./core/stickers";
import { barRuns, drawSticker, type DrawnSticker } from "./stickerDraw";
import type { Box, TextBox } from "./stickerLayout";

const PT_PER_MM = 72 / 25.4;
const BLACK = rgb(0, 0, 0);
const OUTLINE = rgb(0.6, 0.6, 0.6);
/** Capital-letter height as a fraction of the font size (Helvetica / Courier). */
const CAP = 0.72;

export type PdfFormat = "roll" | "grouped";

/** Case + packs page: margin, title line, gaps between stickers (mm). */
export const GROUPED = { marginMm: 5, titleMm: 7, titleFontMm: 3.6, lotGapMm: 4, gapMm: 3, columns: 2 };

interface Fonts {
  bold: PDFFont;
  mono: PDFFont;
}

/** A page plus the conversion from mm measured from its top-left corner to PDF points. */
class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly heightMm: number,
  ) {}
  x(mm: number) {
    return mm * PT_PER_MM;
  }
  /** PDF y of a point `mm` below the top edge. */
  y(mm: number) {
    return (this.heightMm - mm) * PT_PER_MM;
  }
}

/** Text centred in its box (offset by ox, oy); shrunk if it would not fit the box width. */
function text(sheet: Sheet, s: string, box: TextBox, font: PDFFont, ox = 0, oy = 0) {
  let size = box.fontMm * PT_PER_MM;
  const maxW = box.w * PT_PER_MM;
  const w = font.widthOfTextAtSize(s, size);
  if (w > maxW) size *= maxW / w;
  const width = font.widthOfTextAtSize(s, size);
  // Vertical centre of the capitals on the box's centre line.
  sheet.page.drawText(s, { x: sheet.x(ox + box.x) + (maxW - width) / 2, y: sheet.y(oy + box.y + box.h / 2) - (size * CAP) / 2, size, font, color: BLACK });
}

/** One sticker with its top-left corner at (ox, oy) mm; `outline` draws its edge like a die-cut label. */
function drawAt(sheet: Sheet, fonts: Fonts, d: DrawnSticker, ox: number, oy: number, outline: boolean) {
  const { size, layout, sticker } = d;
  if (outline) {
    sheet.page.drawRectangle({ x: sheet.x(ox), y: sheet.y(oy + size.heightMm), width: sheet.x(size.widthMm), height: sheet.x(size.heightMm), borderColor: OUTLINE, borderWidth: 0.5 });
  }
  text(sheet, sticker.header, layout.header, fonts.bold, ox, oy);
  const b = layout.barcode;
  for (const [x, w] of barRuns(d.bars)) {
    sheet.page.drawRectangle({ x: sheet.x(ox + b.x + x * b.moduleMm), y: sheet.y(oy + b.y + b.h), width: sheet.x(w * b.moduleMm), height: sheet.x(b.h), color: BLACK });
  }
  text(sheet, sticker.code, layout.text, fonts.mono, ox, oy);
}

/** Stickers split into groups, each a case/tray sticker followed by its own packs (a reprint may be packs only). */
export function groupByLot(stickers: Sticker[]): Sticker[][] {
  const groups: Sticker[][] = [];
  for (const s of stickers) {
    if (s.kind === "LOT" || !groups.length) groups.push([s]);
    else groups[groups.length - 1].push(s);
  }
  return groups;
}

/** Page size and sticker positions (top-left, mm) of one case + packs page. */
export function groupedPageLayout(group: Sticker[], lotSize: Box, packSize: Box) {
  const { marginMm, titleMm, lotGapMm, gapMm, columns } = GROUPED;
  const lot = group[0]?.kind === "LOT" ? group[0] : null;
  const packs = group.filter((s) => s.kind === "PACK");
  const gridW = columns * packSize.widthMm + (columns - 1) * gapMm;
  const contentW = Math.max(lot ? lotSize.widthMm : 0, packs.length ? gridW : 0);
  const rows = Math.ceil(packs.length / columns);
  let y = marginMm + titleMm;
  const places: { sticker: Sticker; x: number; y: number }[] = [];
  if (lot) {
    places.push({ sticker: lot, x: marginMm + (contentW - lotSize.widthMm) / 2, y });
    y += lotSize.heightMm + (packs.length ? lotGapMm : 0);
  }
  const gridX = marginMm + (contentW - gridW) / 2;
  packs.forEach((p, i) => places.push({ sticker: p, x: gridX + (i % columns) * (packSize.widthMm + gapMm), y: y + Math.floor(i / columns) * (packSize.heightMm + gapMm) }));
  if (rows) y += rows * packSize.heightMm + (rows - 1) * gapMm;
  return { widthMm: contentW + 2 * marginMm, heightMm: y + marginMm, places };
}

function groupTitle(group: Sticker[]): string {
  const lot = group[0]?.kind === "LOT" ? group[0] : null;
  const packs = group.filter((s) => s.kind === "PACK").length;
  const packsLabel = `${packs} pack sticker${packs === 1 ? "" : "s"}`;
  if (!lot) return packsLabel;
  return `${lot.lotType === "CASE" ? "Case" : "Tray"} ${lot.code}: ${lot.lotType.toLowerCase()} sticker + ${packsLabel}`;
}

export async function stickersPdf(stickers: Sticker[], lotSize: Box, packSize: Box, title: string, format: PdfFormat = "roll"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator("Velza");
  const fonts: Fonts = {
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  };
  if (format === "roll") {
    for (const s of stickers) {
      const d = drawSticker(s, lotSize, packSize);
      const sheet = new Sheet(doc.addPage([d.size.widthMm * PT_PER_MM, d.size.heightMm * PT_PER_MM]), d.size.heightMm);
      drawAt(sheet, fonts, d, 0, 0, false);
    }
  } else {
    for (const group of groupByLot(stickers)) {
      const page = groupedPageLayout(group, lotSize, packSize);
      const sheet = new Sheet(doc.addPage([page.widthMm * PT_PER_MM, page.heightMm * PT_PER_MM]), page.heightMm);
      const t: TextBox = { x: GROUPED.marginMm, y: GROUPED.marginMm, w: page.widthMm - 2 * GROUPED.marginMm, h: GROUPED.titleMm - 2, fontMm: GROUPED.titleFontMm };
      text(sheet, groupTitle(group), t, fonts.bold);
      for (const p of page.places) drawAt(sheet, fonts, drawSticker(p.sticker, lotSize, packSize), p.x, p.y, true);
    }
  }
  return doc.save();
}
