import { handler, jsonBody, userIdOf } from "@/lib/api";
import { createPrintOrder, listPrintOrders } from "@/lib/services/printOrders";

export const GET = handler((req) => listPrintOrders(userIdOf(req)));
/** Body `{ batches, preview: true }` returns the summary without saving. */
export const POST = handler(async (req) => createPrintOrder(userIdOf(req), await jsonBody(req)));
