import { handler, userIdOf } from "@/lib/api";
import { damagePhoto } from "@/lib/services/damage";

/** The photo of a damage report: for the reporting partner and Velza HQ only. */
export const GET = handler(async (req, ctx: RouteContext<"/api/damaged/photo/[id]">) => damagePhoto(userIdOf(req), (await ctx.params).id));
