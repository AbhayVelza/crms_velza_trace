import { handler, jsonBody } from "@/lib/api";
import { clientIp, logSecurityEvent, RateLimiter } from "@/lib/security";
import { signup, signupOptions } from "@/lib/services/signup";

// Public (no sign-in): a shop creates its own account. Besides the app-wide limits, at most
// SIGNUPS_PER_HOUR sign-ups per client IP, so the form can't be used to flood the partner list.
const SIGNUPS_PER_HOUR = 5;
const g = globalThis as unknown as { __velzaSignupLimiter?: RateLimiter };
const limiter = (g.__velzaSignupLimiter ??= new RateLimiter(SIGNUPS_PER_HOUR, 3_600_000));

/** The states that already have a Super Stockist, and the approved Super Stockists and Distributors to pick from. */
export const GET = handler(async () => signupOptions());

/** The sign-up form → `{ partner, loginId, pending, message }`. */
export const POST = handler(async (req) => {
  const ip = clientIp(req.headers);
  const wait = limiter.take(ip);
  if (wait) {
    logSecurityEvent("rate-limited (sign-up)", req, ip);
    return Response.json(
      { error: { code: "RATE_LIMITED", message: `Too many sign-ups from this connection — try again in ${Math.ceil(wait / 60)} minute(s)` } },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }
  const r = await signup(await jsonBody(req));
  // The partner record holds the shop's details; the browser needs only what it shows.
  return { id: r.partner.id, name: r.partner.name, type: r.partner.type, loginId: r.loginId, pending: r.pending, message: r.message };
});
