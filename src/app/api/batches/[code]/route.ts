import { handler, userIdOf } from "@/lib/api";
import { batchReport } from "@/lib/services/trace";

export const GET = handler(async (req, ctx: RouteContext<"/api/batches/[code]">) => batchReport(userIdOf(req), (await ctx.params).code));
