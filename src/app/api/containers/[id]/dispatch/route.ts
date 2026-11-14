import { handler, jsonBody, userIdOf } from "@/lib/api";
import { dispatchContainer } from "@/lib/services/containers";

/** `{ toPartnerId, invoice }`: dispatch the whole container to a Velza Warehouse. */
export const POST = handler(async (req, ctx: RouteContext<"/api/containers/[id]/dispatch">) => dispatchContainer(userIdOf(req), (await ctx.params).id, await jsonBody(req)));
