import { handler, jsonBody, userIdOf } from "@/lib/api";
import { notFound } from "@/lib/services/common";
import { deleteEntity, isAdminEntity, updateEntity } from "@/lib/services/admin";

type Ctx = RouteContext<"/api/admin/[entity]/[id]">;

async function target(ctx: Ctx) {
  const { entity, id } = await ctx.params;
  if (!isAdminEntity(entity)) throw notFound(`Admin collection ${entity}`);
  return { entity, id };
}

export const PATCH = handler(async (req, ctx: Ctx) => {
  const { entity, id } = await target(ctx);
  return updateEntity(userIdOf(req), entity, id, await jsonBody(req));
});

/** Refused when the row is referenced by history (deactivate instead). */
export const DELETE = handler(async (req, ctx: Ctx) => {
  const { entity, id } = await target(ctx);
  return deleteEntity(userIdOf(req), entity, id);
});
