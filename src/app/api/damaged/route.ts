import { handler, jsonBody, userIdOf } from "@/lib/api";
import { listDamaged, reportDamaged } from "@/lib/services/damage";
import { MAX_DAMAGE_BODY_BYTES } from "@/lib/services/damagePhotos";

/** The Damaged section of your location. */
export const GET = handler(async (req) => listDamaged(userIdOf(req)));
/**
 * `{code, reason, photo, photoCode, damagePhotos}`: report a case, tray or pack at your location as damaged, with a
 * photo of it showing its barcode and 1 to 4 photos of the damage.
 */
export const POST = handler(async (req) => reportDamaged(userIdOf(req), await jsonBody(req, MAX_DAMAGE_BODY_BYTES)));
