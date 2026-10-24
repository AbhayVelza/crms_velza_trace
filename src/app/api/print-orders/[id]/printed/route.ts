import { handler, userIdOf } from "@/lib/api";
import { markPrinted } from "@/lib/services/printOrders";

export const POST = handler(async (req, ctx: RouteContext<"/api/print-orders/[id]/printed">) => markPrinted(userIdOf(req), (await ctx.params).id));
