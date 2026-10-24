import { handler, userIdOf } from "@/lib/api";
import { listBatches } from "@/lib/services/trace";

export const GET = handler((req) => listBatches(userIdOf(req)));
