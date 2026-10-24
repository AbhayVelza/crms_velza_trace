import { handler, jsonBody, userIdOf } from "@/lib/api";
import { sync } from "@/lib/services/operator";

export const POST = handler(async (req) => sync(userIdOf(req), await jsonBody(req)));
