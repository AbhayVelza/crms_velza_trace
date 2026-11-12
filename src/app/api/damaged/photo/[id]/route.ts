import { handler, userIdOf } from "@/lib/api";
import { damagePhoto } from "@/lib/services/damage";

/** Photo `?n=` of a damage report (none or 0 = the barcode photo, 1–4 = extra photos): for the reporting partner and Velza HQ only. */
export const GET = handler(async (req, ctx: RouteContext<"/api/damaged/photo/[id]">) => {
  const n = Number(new URL(req.url).searchParams.get("n") ?? 0);
  return damagePhoto(userIdOf(req), (await ctx.params).id, n);
});
