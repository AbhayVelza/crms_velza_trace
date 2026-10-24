import { handler, jsonBody, userIdOf } from "@/lib/api";
import { notFound } from "@/lib/services/common";
import { createEntity, isAdminEntity, listEntity } from "@/lib/services/admin";

type Ctx = RouteContext<"/api/admin/[entity]">;

async function entityOf(ctx: Ctx) {
  const { entity } = await ctx.params;
  if (!isAdminEntity(entity)) throw notFound(`Admin collection ${entity}`);
  return entity;
}

export const GET = handler(async (req, ctx: Ctx) => listEntity(userIdOf(req), await entityOf(ctx)));
export const POST = handler(async (req, ctx: Ctx) => createEntity(userIdOf(req), await entityOf(ctx), await jsonBody(req)));
