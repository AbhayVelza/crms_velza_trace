import { handler, jsonBody, userIdOf } from "@/lib/api";
import { takeBack } from "@/lib/services/returns";

/** Velza field staff: `{ code, reason: NOT_SELLING | NEAR_EXPIRY | DAMAGED | OTHER, note?, warehouseId? }`. */
export const POST = handler(async (req) => takeBack(userIdOf(req), await jsonBody(req)));
