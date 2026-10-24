import { handler, userIdOf } from "@/lib/api";
import { dashboard } from "@/lib/services/trace";

export const GET = handler((req) => dashboard(userIdOf(req)));
