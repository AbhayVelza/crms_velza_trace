// Scan-back check: render the same barcode/QR symbols with bwip-js and decode them with ZXing.

import bwipjs from "bwip-js/node";
import { BarcodeFormat, BinaryBitmap, DecodeHintType, HybridBinarizer, MultiFormatReader, RGBLuminanceSource } from "@zxing/library";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { allocateLots } from "@/lib/core/codes";
import { qrUrlFor } from "@/lib/core/stickers";
import { code128Svg, CODE128_OPTIONS, QR_OPTIONS, qrSvg } from "./barcode";
import { lotStickerLayout, modulesFromSvg, packStickerLayout, SPEC } from "./stickerLayout";

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

  it("QR encodes the public lookup URL", async () => {
    const url = qrUrlFor("http://localhost:3000", lots[0].lotCode);
    const png = await bwipjs.toBuffer({ ...QR_OPTIONS, text: url, scale: 4, paddingwidth: 8, paddingheight: 8, backgroundcolor: "FFFFFF" });
    expect(await decodePng(png, BarcodeFormat.QR_CODE)).toBe(url);
  });

  it("SVGs stretch to their container", () => {
    expect(code128Svg(codes[0])).toMatch(/preserveAspectRatio="none"/);
    expect(qrSvg("x")).not.toMatch(/preserveAspectRatio/);
  });
});

describe("sticker layout meets the print spec at default sizes", () => {
  const modules = (list: string[]) => Math.max(...list.map((c) => modulesFromSvg(code128Svg(c))));
  const lotModules = modules(codes.filter((c) => c.length === 15));
  const packModules = modules(codes.filter((c) => c.length === 17));

  it("lot sticker 100×50 mm", () => {
    const l = lotStickerLayout({ widthMm: 100, heightMm: 50 }, lotModules);
    expect(l.warnings).toEqual([]);
    expect(l.barcode.moduleMm).toBeGreaterThanOrEqual(SPEC.minModuleMm);
    expect(l.barcode.heightMm).toBeGreaterThanOrEqual(SPEC.minBarHeightMm);
    expect(l.qrMm).toBeGreaterThanOrEqual(SPEC.minQrMm);
    // bars + 2 quiet zones + QR + gaps fit in the width
    expect(l.barcode.widthMm + 2 * SPEC.quietZoneMm + l.qrMm! + 2 * SPEC.qrQuietMm + 2 + 2 * l.padMm).toBeLessThanOrEqual(100);
  });

  it("pack sticker 75×25 mm", () => {
    const l = packStickerLayout({ widthMm: 75, heightMm: 25 }, packModules);
    expect(l.warnings).toEqual([]);
    expect(l.barcode.moduleMm).toBeGreaterThanOrEqual(SPEC.minModuleMm);
    expect(l.barcode.heightMm).toBeGreaterThanOrEqual(SPEC.minBarHeightMm);
    expect(l.barcode.widthMm + 2 * SPEC.quietZoneMm + 2 * l.padMm).toBeLessThanOrEqual(75);
  });

  it("warns when a sticker is too small", () => {
    expect(packStickerLayout({ widthMm: 40, heightMm: 15 }, packModules).warnings.length).toBeGreaterThan(0);
  });
});
