import { handler, userIdOf } from "@/lib/api";
import { cancelContainer, getContainer } from "@/lib/services/containers";

type Ctx = RouteContext<"/api/containers/[id]">;

/** The container with each of its cases and trays. */
export const GET = handler(async (req, ctx: Ctx) => getContainer(userIdOf(req), (await ctx.params).id));
/** Cancel a container that is still loading. */
export const DELETE = handler(async (req, ctx: Ctx) => cancelContainer(userIdOf(req), (await ctx.params).id));
