import { handler, userIdOf } from "@/lib/api";
import { returnsReport } from "@/lib/services/returns";

/** Velza HQ: every take-back with what the warehouse decided. */
export const GET = handler(async (req) => returnsReport(userIdOf(req)));
