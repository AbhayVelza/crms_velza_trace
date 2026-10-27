import { handler, userIdOf } from "@/lib/api";
import { bootstrap } from "@/lib/services/admin";

/** Reference data for the signed-in user (partners and devices limited to their own). */
export const GET = handler((req) => bootstrap(userIdOf(req)));
