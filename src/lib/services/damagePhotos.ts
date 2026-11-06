// Photos of damaged stock. Every damage report needs one photo that shows the damage and the code's
// barcode or QR, plus 1 to MAX_EXTRA_PHOTOS photos of the damage itself (other angles, close-ups).
// Files are stored on disk, named after the report (its DAMAGED movement's id), so no table changes:
// <upload dir>/damage/<movement id>.<jpg|png|webp> for the barcode photo, <movement id>.<n>.<ext> for
// extra photo n (1…MAX_EXTRA_PHOTOS).
//
// Upload dir: VELZA_UPLOAD_DIR, else "uploads" next to the JSON data file, else data/uploads.
// The barcode itself is read from the photo in the browser (zxing); the server checks that what was
// read is the code being reported, and that the upload really is a JPEG, PNG or WebP image.

import { promises as fs } from "node:fs";
import path from "node:path";
import { extractScannedCode } from "@/lib/core/codes";
import { dbFilePath, storeKind } from "@/lib/store";
import { ServiceError } from "./common";

/** Largest accepted photo (decoded). The page shrinks photos to about 1600 px before sending. */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
/** Photos of the damage per report (at least one), besides the barcode photo. */
export const MAX_EXTRA_PHOTOS = 4;
/** Largest accepted extra photo (decoded). The page shrinks them to about 1280 px before sending. */
export const MAX_EXTRA_PHOTO_BYTES = 1024 * 1024;
/** JSON body limit of the damage report route: the photos travel base64-encoded (4/3 of their size). */
export const MAX_DAMAGE_BODY_BYTES = Math.ceil(((MAX_PHOTO_BYTES + MAX_EXTRA_PHOTOS * MAX_EXTRA_PHOTO_BYTES) * 4) / 3) + 64 * 1024;

const TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;

export interface DamagePhoto {
  bytes: Buffer;
  ext: Ext;
  contentType: string;
}

const photoError = (code: string, message: string) => new ServiceError(400, code, message);

export function uploadDir(): string {
  if (process.env.VELZA_UPLOAD_DIR) return process.env.VELZA_UPLOAD_DIR;
  if (storeKind() === "json") return path.join(path.dirname(dbFilePath()), "uploads");
  return path.join(process.cwd(), "data", "uploads");
}

const damageDir = () => path.join(uploadDir(), "damage");

/** The file type from its first bytes (never from the name or the declared type). */
function sniff(b: Buffer): Ext | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

/** A photo from the request (a data URL or bare base64): a real JPEG/PNG/WebP image of at most `maxBytes`. */
function decodePhoto(raw: string, maxBytes: number, which: string): DamagePhoto {
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw photoError("PHOTO_INVALID", `${which} could not be read — take it again`);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > maxBytes) throw photoError("PHOTO_TOO_LARGE", `${which} is larger than ${maxBytes / 1024 / 1024} MB — take it again`);
  const ext = sniff(bytes);
  if (!ext || bytes.length < 100) throw photoError("PHOTO_INVALID", `${which} must be a JPEG, PNG or WebP image`);
  return { bytes, ext, contentType: TYPES[ext] };
}

/**
 * The photo from the request, checked: present, a real JPEG/PNG/WebP image, at most MAX_PHOTO_BYTES, and the
 * code read from its barcode is the code being reported.
 */
export function checkDamagePhoto(input: { photo?: string | null; photoCode?: string | null; code: string }): DamagePhoto {
  const raw = input.photo?.trim();
  if (!raw) throw photoError("PHOTO_REQUIRED", "Add a photo of the damaged case, tray or pack that shows its barcode");
  const photo = decodePhoto(raw, MAX_PHOTO_BYTES, "The photo");

  const read = extractScannedCode(input.photoCode ?? "");
  if (!read) throw photoError("PHOTO_NO_BARCODE", "No barcode or QR code was found in the photo — retake it with the code label clear and in focus");
  if (read !== extractScannedCode(input.code)) {
    throw photoError("PHOTO_BARCODE_MISMATCH", `The photo shows code ${read}, but ${input.code} is being reported — photograph the damaged item itself`);
  }
  return photo;
}

/** The photos of the damage, checked: 1 to MAX_EXTRA_PHOTOS, each a real image of at most MAX_EXTRA_PHOTO_BYTES. */
export function checkExtraPhotos(list: string[] | null | undefined): DamagePhoto[] {
  const photos = (list ?? []).map((p) => p.trim()).filter(Boolean);
  if (!photos.length) throw photoError("DAMAGE_PHOTO_REQUIRED", "Add at least one photo of the damage itself (the dent, leak or tear)");
  if (photos.length > MAX_EXTRA_PHOTOS) throw photoError("TOO_MANY_PHOTOS", `Add at most ${MAX_EXTRA_PHOTOS} photos of the damage`);
  return photos.map((raw, i) => decodePhoto(raw, MAX_EXTRA_PHOTO_BYTES, `Damage photo ${i + 1}`));
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** File name (without extension) of photo `n` of a report: 0 = the barcode photo, 1… = extra photos. */
const baseName = (reportId: string, n: number) => (n ? `${reportId}.${n}` : reportId);

/**
 * Store the photos of a damage report: the barcode photo, then the extra photos 1…n. Called last inside the
 * report's transaction: if any can't be stored, the ones already written are removed and nothing is saved.
 */
export async function saveDamagePhotos(reportId: string, photo: DamagePhoto, extras: DamagePhoto[] = []): Promise<void> {
  if (!SAFE_ID.test(reportId)) throw new Error(`Unsafe report id for a file name: ${reportId}`);
  const dir = damageDir();
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  try {
    for (const [n, p] of [photo, ...extras].entries()) {
      const final = path.join(dir, `${baseName(reportId, n)}.${p.ext}`);
      const tmp = `${final}.${process.pid}.tmp`;
      await fs.writeFile(tmp, p.bytes);
      await fs.rename(tmp, final);
      written.push(final);
    }
  } catch (e) {
    await Promise.all(written.map((f) => fs.rm(f, { force: true })));
    throw e;
  }
}

/** Photo `n` of a damage report (0 = the barcode photo), or null (reports made before photos were required have none). */
export async function readDamagePhoto(reportId: string, n = 0): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!SAFE_ID.test(reportId) || !Number.isInteger(n) || n < 0 || n > MAX_EXTRA_PHOTOS) return null;
  for (const ext of Object.keys(TYPES) as Ext[]) {
    try {
      return { bytes: await fs.readFile(path.join(damageDir(), `${baseName(reportId, n)}.${ext}`)), contentType: TYPES[ext] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

/** URL of photo `n` of a damage report (0 = the barcode photo). */
export const damagePhotoUrl = (reportId: string, n = 0) => `/api/damaged/photo/${reportId}${n ? `?n=${n}` : ""}`;

/**
 * The photo URLs of these reports (one directory read): the barcode photo first, then the extra photos.
 * Reports without photos are left out.
 */
export async function damagePhotoUrls(reportIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!reportIds.length) return out;
  let names: string[];
  try {
    names = await fs.readdir(damageDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw e;
  }
  const have = new Set(names.filter((n) => !n.endsWith(".tmp")).map((n) => n.slice(0, n.lastIndexOf("."))));
  for (const id of new Set(reportIds)) {
    if (!have.has(id)) continue;
    const urls = [damagePhotoUrl(id)];
    for (let n = 1; n <= MAX_EXTRA_PHOTOS && have.has(baseName(id, n)); n++) urls.push(damagePhotoUrl(id, n));
    out.set(id, urls);
  }
  return out;
}
