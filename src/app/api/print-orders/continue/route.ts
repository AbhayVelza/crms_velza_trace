import { handler, jsonBody, userIdOf } from "@/lib/api";
import { continueBatch, listContinuableBatches } from "@/lib/services/printOrders";

/** The operator's batches with their lot counters, and whether each can be continued. */
export const GET = handler((req) => listContinuableBatches(userIdOf(req)));
/** Body `{ batchCode, cases, trays, idempotencyKey, preview? }`; `preview: true` is read-only. */
export const POST = handler(async (req) => continueBatch(userIdOf(req), await jsonBody(req)));
