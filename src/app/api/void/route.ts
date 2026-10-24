import { handler, jsonBody, userIdOf } from "@/lib/api";
import { voidLot } from "@/lib/services/operator";

export const POST = handler(async (req) => voidLot(userIdOf(req), await jsonBody(req)));
