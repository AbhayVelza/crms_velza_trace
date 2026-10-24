import { handler, jsonBody, userIdOf } from "@/lib/api";
import { openLot } from "@/lib/services/movement";

export const POST = handler(async (req) => openLot(userIdOf(req), await jsonBody(req)));
