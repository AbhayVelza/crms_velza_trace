import { handler, userIdOf } from "@/lib/api";
import { serveReprint } from "@/lib/services/printOrders";

/** The sticker of one logged reprint, served once (a POST: it uses up the reprint authorization). */
export const POST = handler(async (req, ctx: RouteContext<"/api/reprint/[id]/stickers">) => serveReprint(userIdOf(req), (await ctx.params).id));
