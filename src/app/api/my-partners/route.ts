import { handler, userIdOf } from "@/lib/api";
import { myPartners } from "@/lib/services/movement";

/** The partners assigned to you: SS → its distributors and direct retailers, DB → its retailers. */
export const GET = handler(async (req) => myPartners(userIdOf(req)));
