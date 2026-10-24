import { handler, userIdOf } from "@/lib/api";
import { stickersForOrder } from "@/lib/services/printOrders";

/** Sticker sheet (print view data) for a print order. */
export const GET = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]">) => stickersForOrder(userIdOf(req), (await ctx.params).id));
