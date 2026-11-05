// Photos of damaged stock. Every damage report needs one photo that shows the damage and the code's
// barcode or QR. The file is stored on disk, named after the report (its DAMAGED movement's id), so
// no table changes: <upload dir>/damage/<movement id>.<jpg|png|webp>.
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
/** JSON body limit of the damage report route: the photo travels base64-encoded (4/3 of its size). */
export const MAX_DAMAGE_BODY_BYTES = Math.ceil((MAX_PHOTO_BYTES * 4) / 3) + 64 * 1024;

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

/**
 * The photo from the request (a data URL or bare base64), checked: present, a real JPEG/PNG/WebP image,
 * at most MAX_PHOTO_BYTES, and the code read from its barcode is the code being reported.
 */
export function checkDamagePhoto(input: { photo?: string | null; photoCode?: string | null; code: string }): DamagePhoto {
  const raw = input.photo?.trim();
  if (!raw) throw photoError("PHOTO_REQUIRED", "Add a photo of the damaged case, tray or pack that shows its barcode");
  const base64 = raw.startsWith("data:") ? raw.slice(raw.indexOf(",") + 1) : raw;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw photoError("PHOTO_INVALID", "The photo could not be read — take it again");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_PHOTO_BYTES) throw photoError("PHOTO_TOO_LARGE", `The photo is larger than ${MAX_PHOTO_BYTES / 1024 / 1024} MB — take it again`);
  const ext = sniff(bytes);
  if (!ext || bytes.length < 100) throw photoError("PHOTO_INVALID", "The photo must be a JPEG, PNG or WebP image");

  const read = extractScannedCode(input.photoCode ?? "");
  if (!read) throw photoError("PHOTO_NO_BARCODE", "No barcode or QR code was found in the photo — retake it with the code label clear and in focus");
  if (read !== extractScannedCode(input.code)) {
    throw photoError("PHOTO_BARCODE_MISMATCH", `The photo shows code ${read}, but ${input.code} is being reported — photograph the damaged item itself`);
  }
  return { bytes, ext, contentType: TYPES[ext] };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Store the photo of a damage report. Called last inside the report's transaction: if it fails, nothing is saved. */
export async function saveDamagePhoto(reportId: string, photo: DamagePhoto): Promise<void> {
  if (!SAFE_ID.test(reportId)) throw new Error(`Unsafe report id for a file name: ${reportId}`);
  const dir = damageDir();
  await fs.mkdir(dir, { recursive: true });
  const final = path.join(dir, `${reportId}.${photo.ext}`);
  const tmp = `${final}.${process.pid}.tmp`;
  await fs.writeFile(tmp, photo.bytes);
  await fs.rename(tmp, final);
}

/** The stored photo of a damage report, or null (reports made before photos were required have none). */
export async function readDamagePhoto(reportId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!SAFE_ID.test(reportId)) return null;
  for (const ext of Object.keys(TYPES) as Ext[]) {
    try {
      return { bytes: await fs.readFile(path.join(damageDir(), `${reportId}.${ext}`)), contentType: TYPES[ext] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}

/** Which of these reports have a photo (one directory read). */
export async function reportsWithPhoto(reportIds: string[]): Promise<Set<string>> {
  if (!reportIds.length) return new Set();
  let names: string[];
  try {
    names = await fs.readdir(damageDir());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw e;
  }
  const have = new Set(names.filter((n) => !n.endsWith(".tmp")).map((n) => n.slice(0, n.lastIndexOf("."))));
  return new Set(reportIds.filter((id) => have.has(id)));
}
