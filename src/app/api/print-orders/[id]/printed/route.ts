import { handler, jsonBody, userIdOf } from "@/lib/api";
import { markPrinted } from "@/lib/services/printOrders";

/**
 * `{ lotType?: "CASE" | "TRAY" }`: confirm one print run (cases or trays are printed on separate label rolls), or
 * the whole order without it. A POST with no body still confirms the whole order.
 */
export const POST = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]/printed">) => {
  const body = req.headers.get("content-type") ? await jsonBody(req) : {};
  return markPrinted(userIdOf(req), (await ctx.params).id, body);
});
