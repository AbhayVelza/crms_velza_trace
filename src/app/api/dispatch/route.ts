import { handler, jsonBody, userIdOf } from "@/lib/api";
import { destinations, dispatch } from "@/lib/services/movement";

/** Allowed destinations for the current user: the tiers it supplies, only the partners assigned to it. */
export const GET = handler((req) => destinations(userIdOf(req)));
/** `{action:"check", code, ...}` validates one scan; `{action:"confirm", codes, ...}` dispatches all or nothing. */
export const POST = handler(async (req) => dispatch(userIdOf(req), await jsonBody(req)));
