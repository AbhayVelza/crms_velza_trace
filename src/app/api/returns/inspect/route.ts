import { handler, jsonBody, userIdOf } from "@/lib/api";
import { inspectReturn } from "@/lib/services/returns";

/** Velza Warehouse: `{ code, decision: BACK_TO_STOCK | WRITE_OFF, writeOffAs?: DAMAGED | EXPIRED, note? }`. */
export const POST = handler(async (req) => inspectReturn(userIdOf(req), await jsonBody(req)));
