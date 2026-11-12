import { handler, jsonBody, userIdOf } from "@/lib/api";
import { markPrinted } from "@/lib/services/printOrders";

/**
 * Optional JSON body `{ deviceId?, lotType? }`: `deviceId` is the PC confirming (named on the PRINTED movements when
 * it is not the order's PC); `lotType` ("CASE" | "TRAY") confirms one print run only, since cases and trays are
 * printed on separate label rolls. A POST with no body confirms the whole order.
 */
export const POST = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]/printed">) =>
  markPrinted(userIdOf(req), (await ctx.params).id, req.headers.get("content-type") ? await jsonBody(req) : undefined),
);
