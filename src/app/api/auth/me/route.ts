import { handler, userIdOf } from "@/lib/api";
import { me } from "@/lib/services/auth";

/** The signed-in user (401 if not signed in). */
export const GET = handler(async (req) => me(userIdOf(req)));
