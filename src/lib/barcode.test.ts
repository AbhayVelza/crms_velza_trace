// Scan-back check: render the same barcode symbols (and the QR of older lot stickers) with bwip-js and decode them with ZXing.

import bwipjs from "bwip-js/node";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { allocateLots } from "@/lib/core/codes";
import { code128Svg, CODE128_OPTIONS, QR_OPTIONS } from "./barcode";
import { PDFDocument } from "pdf-lib";
import { stickersForLots } from "@/lib/core/stickers";
import { DEFAULT_SETTINGS } from "@/lib/core/types";

/** Label sizes used at the plant for DH3493 (the app defaults, set per install, are larger). */
const PLANT_LOT = { widthMm: 70, heightMm: 25 };
const PLANT_PACK = { widthMm: 45, heightMm: 15 };
import { barRuns, drawSticker } from "./stickerDraw";
import { lotStickerLayout, modulesFromSvg, packStickerLayout, SPEC, type Rect, type StickerLayout } from "./stickerLayout";
import { groupByLot, groupedPageLayout, stickersPdf } from "./stickerPdf";

async function decodePng(buf: Buffer, format: BarcodeFormat): Promise<string> {
  const png = PNG.sync.read(buf);
  const lum = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0; i < lum.length; i++) {
    const [r, g, b, a] = [png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2], png.data[i * 4 + 3]];
    lum[i] = a < 128 ? 255 : (r * 299 + g * 587 + b * 114) / 1000;
  }
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [format]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  reader.setHints(hints);
  return reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, png.width, png.height)))).getText();
}

const { lots } = allocateLots({ code: "Q7Z9K2", country: "91", flavour: "GA", nextLot: 0x1869a }, 3, 3);
const codes = lots.flatMap((l) => [l.lotCode, ...l.packCodes]);

describe("barcodes scan back", () => {
  it.each(codes.slice(0, 12))("Code 128 %s", async (code) => {
    const png = await bwipjs.toBuffer({ ...CODE128_OPTIONS, text: code, scale: 3, paddingwidth: 10, paddingheight: 5, backgroundcolor: "FFFFFF" });
    expect(await decodePng(png, BarcodeFormat.CODE_128)).toBe(code);
  });

  it("QR of an older lot sticker (public lookup URL) still decodes", async () => {
    const url = `http://localhost:3000/t/${lots[0].lotCode}`;
    const png = await bwipjs.toBuffer({ ...QR_OPTIONS, text: url, scale: 4, paddingwidth: 8, paddingheight: 8, backgroundcolor: "FFFFFF" });
    expect(await decodePng(png, BarcodeFormat.QR_CODE)).toBe(url);
  });

  it("SVGs stretch to their container", () => {
    expect(code128Svg(codes[0])).toMatch(/preserveAspectRatio="none"/);
  });
});

describe("sticker layout at the plant label sizes (case/tray 70×25 mm, pack 45×15 mm)", () => {
  const LOT = PLANT_LOT;
  const PACK = PLANT_PACK;
  const stickers = stickersForLots(
    lots.map((l, i) => ({ lotCode: l.lotCode, lotType: i % 2 ? ("TRAY" as const) : ("CASE" as const), flavourName: "Green Apple" })),
  );
  const drawn = stickers.map((s) => drawSticker(s, LOT, PACK));
  const lot = drawn.find((d) => d.sticker.kind === "LOT")!;
  const pack = drawn.find((d) => d.sticker.kind === "PACK")!;

  const inside = (r: Rect, size: { widthMm: number; heightMm: number }) => r.x >= 0 && r.y >= 0 && r.x + r.w <= size.widthMm + 1e-9 && r.y + r.h <= size.heightMm + 1e-9;
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  /** The bars with their quiet zones. */
  const barsArea = (l: StickerLayout): Rect => ({ x: l.barcode.x - l.barcode.quietMm, y: l.barcode.y, w: l.barcode.w + 2 * l.barcode.quietMm, h: l.barcode.h });

  it("the plant labels are 70×25 and 45×15 mm (the app defaults stay larger)", () => {
    expect(DEFAULT_SETTINGS.lotSticker.widthMm).toBeGreaterThanOrEqual(PLANT_LOT.widthMm);
    expect(LOT).toEqual({ widthMm: 70, heightMm: 25 });
    expect(PACK).toEqual({ widthMm: 45, heightMm: 15 });
  });

  it.each(drawn.map((d) => [d.sticker.code, d] as const))("%s fits: no warnings, everything inside, nothing overlapping", (_code, d) => {
    const l = d.layout;
    expect(l.warnings).toEqual([]);
    const parts = [l.header, barsArea(l), l.text];
    for (const p of parts) expect(inside(p, d.size)).toBe(true);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) expect(overlap(parts[i], parts[j])).toBe(false);
    expect(l.barcode.moduleMm).toBeGreaterThanOrEqual(SPEC.minModuleMm);
    expect(l.barcode.h).toBeGreaterThanOrEqual(SPEC.minBarHeightMm);
    expect(l.barcode.w).toBeCloseTo(d.bars.reduce((a, b) => a + b, 0) * l.barcode.moduleMm, 6);
  });

  it("no sticker carries a QR code", () => {
    expect(Object.keys(lot.sticker).sort()).toEqual(["code", "header", "kind", "lotType"]);
    expect(Object.keys(lot.layout).sort()).toEqual(["barcode", "header", "text", "warnings"]);
  });

  it("case/tray barcode is bigger than the pack barcode", () => {
    expect(lot.layout.barcode.moduleMm).toBeGreaterThan(pack.layout.barcode.moduleMm);
    expect(lot.layout.barcode.h).toBeGreaterThan(pack.layout.barcode.h);
  });

  it("bar runs cover exactly the symbol's dark modules", () => {
    expect(barRuns(lot.bars).reduce((a, [, w]) => a + w, 0)).toBe(lot.bars.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0));
    expect(lot.bars.reduce((a, b) => a + b, 0)).toBe(modulesFromSvg(code128Svg(lot.sticker.code)));
  });

  it("warns when a sticker is too small", () => {
    expect(packStickerLayout({ widthMm: 30, heightMm: 15 }, { header: pack.sticker.header, code: pack.sticker.code, modules: 200 }).warnings.length).toBeGreaterThan(0);
    expect(lotStickerLayout({ widthMm: 30, heightMm: 25 }, { header: lot.sticker.header, code: lot.sticker.code, modules: 189 }).warnings.length).toBeGreaterThan(0);
  });

  it("PDF: one page per sticker, each the sticker's real size", async () => {
    const one = stickers.slice(0, 5); // a case: its lot sticker and 4 packs
    const doc = await PDFDocument.load(await stickersPdf(one, LOT, PACK, "test"));
    const sizes = doc.getPages().map((p) => p.getSize()).map(({ width, height }) => [Math.round((width * 25.4) / 72), Math.round((height * 25.4) / 72)]);
    expect(sizes).toEqual([[70, 25], [45, 15], [45, 15], [45, 15], [45, 15]]);
  });
});

describe("PDF: case/tray + its packs, one page each", () => {
  const LOT = PLANT_LOT;
  const PACK = PLANT_PACK;
  const stickers = stickersForLots([
    { lotCode: "91ABC123OR00001", lotType: "CASE", flavourName: "Original" },
    { lotCode: "91ABC123OR00002", lotType: "CASE", flavourName: "Original" },
    { lotCode: "91ABC123GA00003", lotType: "TRAY", flavourName: "Green Apple" },
  ]);

  it("groups each case/tray sticker with its own packs, in print order", () => {
    const groups = groupByLot(stickers);
    expect(groups.map((g) => g.map((s) => s.code.slice(-7)))).toEqual([
      ["OR00001", "0000161", "0000162", "0000163", "0000164"],
      ["OR00002", "0000261", "0000262", "0000263", "0000264"],
      ["GA00003", "0000341", "0000342", "0000343", "0000344", "0000345", "0000346"],
    ]);
    // every pack belongs to the case/tray sticker it follows
    for (const [lot, ...packs] of groups) for (const p of packs) expect(p.code.startsWith(lot.code)).toBe(true);
  });

  it("case: sticker on top, packs 2 × 2 under it; tray: 3 × 2; all inside the page, none overlapping", () => {
    for (const [group, rows] of [[groupByLot(stickers)[0], 2], [groupByLot(stickers)[2], 3]] as const) {
      const page = groupedPageLayout(group, LOT, PACK);
      const rects = page.places.map((p) => ({ x: p.x, y: p.y, w: p.sticker.kind === "LOT" ? LOT.widthMm : PACK.widthMm, h: p.sticker.kind === "LOT" ? LOT.heightMm : PACK.heightMm }));
      const [lot, ...packs] = rects;
      for (const p of packs) expect(p.y).toBeGreaterThanOrEqual(lot.y + lot.h);
      expect(new Set(packs.map((p) => p.x)).size).toBe(2);
      expect(new Set(packs.map((p) => p.y)).size).toBe(rows);
      for (const r of rects) expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= page.widthMm && r.y + r.h <= page.heightMm).toBe(true);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const [a, b] = [rects[i], rects[j]];
          expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
        }
    }
  });

  it("one page per case/tray", async () => {
    const doc = await PDFDocument.load(await stickersPdf(stickers, LOT, PACK, "test", "grouped"));
    expect(doc.getPageCount()).toBe(3);
  });
});

describe("stickers scan back at real size on a 300 dpi printer", () => {
  const DPI = 300;
  const pxPerMm = DPI / 25.4;
  /** Rasterize dark rectangles (mm) the way a printer does: each edge snaps to the nearest dot. */
  function raster(widthMm: number, heightMm: number, rects: Rect[]): Buffer {
    const w = Math.round(widthMm * pxPerMm);
    const h = Math.round(heightMm * pxPerMm);
    const png = new PNG({ width: w, height: h });
    png.data.fill(255);
    for (const r of rects) {
      const [x0, x1, y0, y1] = [r.x, r.x + r.w, r.y, r.y + r.h].map((v) => Math.round(v * pxPerMm));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) png.data.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
    }
    return PNG.sync.write(png);
  }
  const stickers = stickersForLots([{ lotCode: lots[0].lotCode, lotType: "TRAY", flavourName: "Green Apple" }]);
  const drawn = stickers.slice(0, 2).map((s) => drawSticker(s, DEFAULT_SETTINGS.lotSticker, DEFAULT_SETTINGS.packSticker));

  it.each(drawn.map((d) => [d.sticker.kind, d] as const))("%s barcode decodes", async (_kind, d) => {
    const b = d.layout.barcode;
    const rects = barRuns(d.bars).map(([x, w]) => ({ x: b.x + x * b.moduleMm, y: b.y, w: w * b.moduleMm, h: b.h }));
    expect(await decodePng(raster(d.size.widthMm, d.size.heightMm, rects), BarcodeFormat.CODE_128)).toBe(d.sticker.code);
  });
});
