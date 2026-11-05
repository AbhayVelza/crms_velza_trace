import { handler, jsonBody, sessionCookie } from "@/lib/api";
import { clientIp } from "@/lib/security";
import { login } from "@/lib/services/auth";

/** `{loginId, password}` → sets the HttpOnly session cookie and returns the signed-in user. Lockout is per sign-in ID and client IP. */
export const POST = handler(async (req) => {
  const { token, expiresAt, user } = await login(await jsonBody(req), clientIp(req.headers));
  return Response.json(user, { headers: { "set-cookie": sessionCookie(req, token, expiresAt) } });
});
