import { handler, jsonBody, sessionCookie } from "@/lib/api";
import { login } from "@/lib/services/auth";

/** `{loginId, password}` → sets the HttpOnly session cookie and returns the signed-in user. */
export const POST = handler(async (req) => {
  const { token, expiresAt, user } = await login(await jsonBody(req));
  return Response.json(user, { headers: { "set-cookie": sessionCookie(req, token, expiresAt) } });
});
