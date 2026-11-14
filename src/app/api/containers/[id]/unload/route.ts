import { handler, jsonBody, userIdOf } from "@/lib/api";
import { unloadContainer } from "@/lib/services/containers";

/** `{ code }`: take a case or tray out of a container that is still loading. */
export const POST = handler(async (req, ctx: RouteContext<"/api/containers/[id]/unload">) => unloadContainer(userIdOf(req), (await ctx.params).id, await jsonBody(req)));
