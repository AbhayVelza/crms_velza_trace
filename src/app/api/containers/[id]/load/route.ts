import { handler, jsonBody, userIdOf } from "@/lib/api";
import { loadContainer } from "@/lib/services/containers";

/** `{ code }`: scan a case or tray into the container. */
export const POST = handler(async (req, ctx: RouteContext<"/api/containers/[id]/load">) => loadContainer(userIdOf(req), (await ctx.params).id, await jsonBody(req)));
