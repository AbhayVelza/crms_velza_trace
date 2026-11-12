// Scan input normalisation and format check, shared by the keyboard-wedge box, manual entry and the camera.
// The server stays authoritative: this only cleans what a scanner sends and refuses things that cannot be a code.

import { extractScannedCode, LOT_CODE_LENGTH, PACK_CODE_LENGTH, parseCode } from "@/lib/core/codes";

// Some scanners add a prefix/suffix (Tab, GS, CR/LF, a BOM). None of them can be part of a code.
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g;

/**
 * Raw scanner/camera/typed text → the code to send. Strips control characters and surrounding spaces, takes the last
 * path segment of a QR URL (`…/t/<code>`), and upper-cases a value made only of letters and digits (codes are
 * [0-9A-Z]; a scanner in a lower-case keyboard layout must not turn a valid code into an unknown one). Characters
 * are never removed from inside the code, so leading zeros and hex digits are kept as they are.
 */
export function normalizeScannedCode(raw: string): string {
  const code = extractScannedCode(raw.replace(CONTROL, ""));
  return /^[0-9a-z]+$/i.test(code) ? code.toUpperCase() : code;
}

export type CodeCheck = { ok: true; code: string; kind: "LOT" | "PACK" } | { ok: false; code: string; message: string };

/** Format only (length and structure): 15 characters = case/tray lot code, 17 = pack code. */
export function checkCodeFormat(raw: string): CodeCheck {
  const code = normalizeScannedCode(raw);
  if (!code) return { ok: false, code, message: "Scan or type a code first" };
  if (code.length !== LOT_CODE_LENGTH && code.length !== PACK_CODE_LENGTH) {
    return { ok: false, code, message: `${code} is not a Velza code: a case or tray code has ${LOT_CODE_LENGTH} characters, a pack code ${PACK_CODE_LENGTH} (this one has ${code.length})` };
  }
  const parsed = parseCode(code, { countries: null, flavours: null });
  if (!parsed.ok) return { ok: false, code, message: `${code} is not a Velza code: ${parsed.error.message}` };
  return { ok: true, code, kind: parsed.value.kind };
}

/**
 * Longest raw scan input the server accepts (a full QR link with a long host still fits). Anything longer is not a
 * Velza code and is refused before it reaches the scan audit.
 */
export const MAX_SCAN_INPUT = 256;

/**
 * Public QR page input → what to look up and whether to log it. Only a well-formed code (format check passes) is
 * worth a scan-audit row: garbage, over-long text or a broken link is answered "Unregistered code" and never logged,
 * so nobody can fill the audit log or HQ alerts by typing junk into /t/<anything>.
 */
export function publicScanInput(raw: string): { code: string; loggable: boolean } {
  if (typeof raw !== "string" || raw.length > MAX_SCAN_INPUT) return { code: "", loggable: false };
  const check = checkCodeFormat(raw);
  return check.ok ? { code: check.code, loggable: true } : { code: check.code.slice(0, 40), loggable: false };
}
