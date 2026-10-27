import { handler, jsonBody, userIdOf } from "@/lib/api";
import { listDamaged, reportDamaged } from "@/lib/services/damage";

/** The Damaged section of your location. */
export const GET = handler(async (req) => listDamaged(userIdOf(req)));
/** `{code, reason}`: report a case, tray or pack at your location as damaged. */
export const POST = handler(async (req) => reportDamaged(userIdOf(req), await jsonBody(req)));
