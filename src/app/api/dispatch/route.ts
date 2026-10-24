import { handler, jsonBody, userIdOf } from "@/lib/api";
import { destinations, dispatch } from "@/lib/services/movement";

/** Allowed destinations (next tier only) for the current user. */
export const GET = handler((req) => destinations(userIdOf(req)));
/** `{action:"check", code, ...}` validates one scan; `{action:"confirm", codes, ...}` dispatches all or nothing. */
export const POST = handler(async (req) => dispatch(userIdOf(req), await jsonBody(req)));
