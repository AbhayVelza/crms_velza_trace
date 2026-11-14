// The /t/<code> route value as the public page passes it on. Kept out of page.tsx so it can be unit tested.

/** A QR link is never longer than this; anything longer is not a Velza code (the lookup answers "Unregistered code"). */
export const MAX_CODE_PARAM = 256;

/** The route value, decoded once. A broken % sequence (/t/%E0%A4%A) is kept as it is rather than failing the page. */
export function codeFromParam(raw: string): string {
  let code = raw;
  try {
    code = decodeURIComponent(raw);
  } catch {
    // keep the raw value: the lookup answers "Unregistered code"
  }
  // One character over the limit is kept so the lookup still sees the value as too long.
  return code.slice(0, MAX_CODE_PARAM + 1);
}
