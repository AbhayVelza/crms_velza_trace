import { handler, jsonBody, userIdOf } from "@/lib/api";
import { deleteBatchCode, updateBatchCode } from "@/lib/services/admin";

type Ctx = RouteContext<"/api/admin/batch-codes/[id]">;

/** Edit `{ code }` or delete a batch code; refused once the batch has lots. */
export const PATCH = handler(async (req, ctx: Ctx) => updateBatchCode(userIdOf(req), (await ctx.params).id, await jsonBody(req)));
export const DELETE = handler(async (req, ctx: Ctx) => deleteBatchCode(userIdOf(req), (await ctx.params).id));
