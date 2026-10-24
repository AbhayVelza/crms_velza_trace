import { handler, userIdOf } from "@/lib/api";
import { alerts } from "@/lib/services/trace";

export const GET = handler((req) => alerts(userIdOf(req)));
