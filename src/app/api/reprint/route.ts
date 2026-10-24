import { handler, jsonBody, userIdOf } from "@/lib/api";
import { listReprints, reprint } from "@/lib/services/operator";

export const GET = handler((req) => listReprints(userIdOf(req)));
export const POST = handler(async (req) => reprint(userIdOf(req), await jsonBody(req)));
