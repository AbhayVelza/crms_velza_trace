import { handler, jsonBody, userIdOf } from "@/lib/api";
import { receive } from "@/lib/services/movement";

export const POST = handler(async (req) => receive(userIdOf(req), await jsonBody(req)));
