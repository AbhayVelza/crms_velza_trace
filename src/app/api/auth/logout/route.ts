import { clearSessionCookie, handler, sessionTokenOf } from "@/lib/api";
import { logout } from "@/lib/services/auth";

export const POST = handler(async (req) => Response.json(await logout(sessionTokenOf(req)), { headers: { "set-cookie": clearSessionCookie(req) } }));
