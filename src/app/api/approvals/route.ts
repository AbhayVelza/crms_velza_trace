import { handler, jsonBody, userIdOf } from "@/lib/api";
import { approvalAction, listApprovals } from "@/lib/services/admin";

/** HQ: partner accounts and their approval state. */
export const GET = handler(async (req) => listApprovals(userIdOf(req)));
/** `{userId, action: approve|reject|revoke|resubmit, reason?}` (resubmit is the Admin's). */
export const POST = handler(async (req) => approvalAction(userIdOf(req), await jsonBody(req)));
