import { handler, jsonBody, userIdOf } from "@/lib/api";
import { notFound } from "@/lib/services/common";
import { isAdminEntity, updateEntity } from "@/lib/services/admin";

export const PATCH = handler(async (req, ctx: RouteContext<"/api/admin/[entity]/[id]">) => {
  const { entity, id } = await ctx.params;
  if (!isAdminEntity(entity)) throw notFound(`Admin collection ${entity}`);
  return updateEntity(userIdOf(req), entity, id, await jsonBody(req));
});
