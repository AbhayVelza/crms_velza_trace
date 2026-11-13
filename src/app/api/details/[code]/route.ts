import { handler, userIdOf } from "@/lib/api";
import { productDetails } from "@/lib/services/details";

/** A malformed % sequence must not throw: it is then looked up as typed (and not found). */
function decoded(code: string): string {
  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

/** Product details of a scanned case, tray or pack for the signed-in partner (plant, warehouse, SS, DB, Retailer). */
export const GET = handler(async (req, ctx: RouteContext<"/api/details/[code]">) => productDetails(userIdOf(req), decoded((await ctx.params).code)));
