import { handler, jsonBody, userIdOf } from "@/lib/api";
import { decideApproval } from "@/lib/services/admin";

/** `{ decision: "approve" | "reject" }` for a self-signed-up Super Stockist or Distributor (Velza Admin only). */
export const POST = handler(async (req, ctx: RouteContext<"/api/admin/approvals/[id]">) =>
  decideApproval(userIdOf(req), (await ctx.params).id, await jsonBody(req)),
);
