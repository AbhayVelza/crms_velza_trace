import { handler, userIdOf } from "@/lib/api";
import { pendingReturns } from "@/lib/services/returns";

/** Velza Warehouse: returns received here that wait for their inspection. */
export const GET = handler(async (req) => pendingReturns(userIdOf(req)));
