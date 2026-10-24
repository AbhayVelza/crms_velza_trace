import { handler, jsonBody, userIdOf } from "@/lib/api";
import { setDeviceOffline } from "@/lib/services/operator";

/** `{ offline: boolean }` — the device Online/Offline toggle. */
export const PATCH = handler(async (req, ctx: RouteContext<"/api/devices/[id]">) =>
  setDeviceOffline(userIdOf(req), (await ctx.params).id, await jsonBody(req)),
);
