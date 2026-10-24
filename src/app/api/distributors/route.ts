import { handler, userIdOf } from "@/lib/api";
import { myDistributors } from "@/lib/services/movement";

/** Super Stockist: its assigned distributors. */
export const GET = handler(async (req) => myDistributors(userIdOf(req)));
