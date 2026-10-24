import { handler, userIdOf } from "@/lib/api";
import { lookup, publicLookup } from "@/lib/services/trace";

/** HQ search with full timeline, or `?view=public` for the QR page (safe fields only). */
export const GET = handler(async (req, ctx: RouteContext<"/api/lookup/[code]">) => {
  const { code } = await ctx.params;
  const view = new URL(req.url).searchParams.get("view");
  return view === "public" ? publicLookup(decodeURIComponent(code)) : lookup(userIdOf(req), decodeURIComponent(code));
});
