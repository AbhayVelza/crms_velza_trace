import { handler, jsonBody, userIdOf } from "@/lib/api";
import { markPrinted } from "@/lib/services/printOrders";

/**
 * Optional JSON body `{ lotType?: "CASE" | "TRAY", deviceId? }`. `lotType` confirms one print run (cases and trays
 * are printed on separate label rolls); without it the whole order is confirmed (a POST with no body too).
 * `deviceId` is the PC confirming (named on the PRINTED movements when it is not the order's PC).
 */
export const POST = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]/printed">) =>
  markPrinted(userIdOf(req), (await ctx.params).id, req.headers.get("content-type") ? await jsonBody(req) : undefined),
);
