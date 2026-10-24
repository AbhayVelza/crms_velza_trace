import { handler, jsonBody, userIdOf } from "@/lib/api";
import { verify } from "@/lib/services/verify";

export const POST = handler(async (req) => verify(userIdOf(req), await jsonBody(req)));
