import { handler, userIdOf } from "@/lib/api";
import { bootstrap } from "@/lib/services/admin";

export const GET = handler(async (req) => bootstrap(userIdOf(req)));
