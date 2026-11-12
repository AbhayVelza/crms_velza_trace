// Browser side of damage photos: read the barcode / QR in the photo (zxing, already used by the camera
// scanner) and shrink the photo to a JPEG small enough to upload. Runs only in the browser.

import type { DecodeHintType as Hint } from "@zxing/library";
import { extractScannedCode } from "@/lib/core/codes";

/** Barcode photo: longest side in pixels, and under the server's 2 MB limit with room to spare. */
const UPLOAD = { side: 1600, maxBytes: 1.8 * 1024 * 1024 };
/** Extra photos of the damage: smaller, under the server's 1 MB limit for each. */
const EXTRA_UPLOAD = { side: 1280, maxBytes: 0.9 * 1024 * 1024 };

export interface PreparedPhoto {
  /** JPEG data URL to send. */
  dataUrl: string;
  /** Code read from the photo's barcode or QR (a QR's URL reduced to its code), or null if none was found. */
  code: string | null;
  bytes: number;
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded image stays usable after the object URL is released.
    URL.revokeObjectURL(url);
  }
}

function canvasOf(img: HTMLImageElement, longSide: number, blurPx = 0): HTMLCanvasElement {
  const scale = Math.min(1, longSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const g = canvas.getContext("2d")!;
  if (blurPx) g.filter = `blur(${blurPx}px)`;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Sizes (long side, px) and blur to try, cheapest first. A phone photo's sensor noise around the sticker makes
 * ZXing's finder see false patterns at full size; shrinking (or a slight blur) averages the noise away, while
 * a small sticker in a big photo needs the larger sizes. Checked on noisy, rotated test photos of real stickers.
 */
const ATTEMPTS = [
  { side: 1200, blur: 0 },
  { side: 800, blur: 0 },
  { side: 1600, blur: 1 },
  { side: 1600, blur: 0 },
  { side: 2400, blur: 1 },
  { side: 3200, blur: 0 },
];

/** The first Code 128 or QR code found, trying a few sizes (small codes need more pixels, noisy photos fewer). */
async function readCode(img: HTMLImageElement): Promise<string | null> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import("@zxing/browser"), import("@zxing/library")]);
  const hints = new Map<Hint, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  const reader = new BrowserMultiFormatReader(hints);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  // Sizes above the photo's own size add nothing (canvasOf never enlarges).
  const attempts = ATTEMPTS.filter((a) => a.side <= Math.max(longest, 1200));
  for (const { side, blur } of attempts) {
    try {
      return extractScannedCode(reader.decodeFromCanvas(canvasOf(img, side, blur)).getText());
    } catch (e) {
      // NotFoundException = nothing found at this size: try the next one. Anything else is a real failure.
      if ((e as Error)?.name !== "NotFoundException") console.warn("[damage photo] barcode reader failed", e);
    }
  }
  return null;
}

function toJpeg(img: HTMLImageElement, { side, maxBytes }: { side: number; maxBytes: number }): { dataUrl: string; bytes: number } {
  const canvas = canvasOf(img, side);
  let out = { dataUrl: "", bytes: Infinity };
  for (const quality of [0.85, 0.7, 0.55, 0.4]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    out = { dataUrl, bytes: Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4) };
    if (out.bytes <= maxBytes) break;
  }
  return out;
}

async function openPhoto(file: File): Promise<HTMLImageElement> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name || "This file"} is not a photo (an image file)`);
  try {
    return await loadImage(file);
  } catch {
    throw new Error(`${file.name || "This photo"} could not be opened — take it again or choose a JPEG or PNG`);
  }
}

/** Read the code in the photo and prepare the upload. Throws if the file is not an image the browser can open. */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const img = await openPhoto(file);
  const code = await readCode(img);
  return { ...toJpeg(img, UPLOAD), code };
}

/** An extra photo of the damage (no barcode needed): shrunk to a JPEG for upload. */
export async function prepareExtraPhoto(file: File): Promise<{ dataUrl: string; bytes: number }> {
  return toJpeg(await openPhoto(file), EXTRA_UPLOAD);
}
