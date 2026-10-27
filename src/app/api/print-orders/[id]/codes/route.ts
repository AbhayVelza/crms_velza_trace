import { handler, userIdOf } from "@/lib/api";
import { codesForOrder } from "@/lib/services/printOrders";

/** Every code of a print order with all its fields, plus sticker totals and sync status. */
export const GET = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]/codes">) => codesForOrder(userIdOf(req), (await ctx.params).id));
