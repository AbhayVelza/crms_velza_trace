import { handler, jsonBody, sessionCookie } from "@/lib/api";
import { devLogin } from "@/lib/services/auth";

/** While sign-in is off: `{userId}` → act as that person (sets the session cookie). 404 when sign-in is on. */
export const POST = handler(async (req) => {
  const { token, expiresAt, user } = await devLogin(await jsonBody(req));
  return Response.json(user, { headers: { "set-cookie": sessionCookie(req, token, expiresAt) } });
});
