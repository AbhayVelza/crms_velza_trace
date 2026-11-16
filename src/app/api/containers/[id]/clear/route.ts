import { handler, jsonBody, userIdOf } from "@/lib/api";
import { clearContainer } from "@/lib/services/containers";

/** `{ billOfEntry? }`: Customs clears a received container — its held cases and trays become dispatchable. */
export const POST = handler(async (req, ctx: RouteContext<"/api/containers/[id]/clear">) => clearContainer(userIdOf(req), (await ctx.params).id, await jsonBody(req)));
