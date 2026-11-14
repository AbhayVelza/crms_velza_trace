import { handler, userIdOf } from "@/lib/api";
import { clientIp } from "@/lib/security";
import { lookup, publicLookup } from "@/lib/services/trace";

/** A malformed % sequence (e.g. "%E0%A4%A") must not throw: it is then looked up as typed (and not found). */
function decoded(code: string): string {
  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

/** HQ search with full timeline, or `?view=public` for the QR page (safe fields only). */
export const GET = handler(async (req, ctx: RouteContext<"/api/lookup/[code]">) => {
  const { code } = await ctx.params;
  const view = new URL(req.url).searchParams.get("view");
  return view === "public"
    ? publicLookup(decoded(code), { clientKey: clientIp(req.headers) })
    : lookup(userIdOf(req), decoded(code));
});
