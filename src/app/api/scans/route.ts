import { handler, userIdOf } from "@/lib/api";
import { listScans } from "@/lib/services/trace";

export const GET = handler((req) => listScans(userIdOf(req)));
