// Server-side form of a scanned code, for zod request schemas. Kept out of normalize.ts so the scan screens (client
// components) do not pull zod into the browser bundle.

import { z } from "zod";
import { MAX_SCAN_INPUT, normalizeScannedCode } from "./normalize";

/**
 * A scanned code as the server takes it: at most MAX_SCAN_INPUT characters, then the same clean-up as the scan screens
 * (control characters, spaces, a full QR link `.../t/<code>`, lower case). A raw code and its QR link become one value.
 */
export const scannedCodeSchema = z.string().max(MAX_SCAN_INPUT, "Not a Velza code").transform(normalizeScannedCode);
