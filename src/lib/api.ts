// Route handler plumbing: session cookie → signed-in user, error → JSON mapping, JSON body parsing.
// Routes stay thin: validate (zod, inside services) → call a service → return JSON.

import { connection } from "next/server";
import { ZodError } from "zod";
import { NotFoundError } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/sessionCookie";
import { sessionUserId } from "@/lib/services/auth";
import { badRequest, forbidden, ServiceError } from "@/lib/services/common";

export { SESSION_COOKIE };

// Signed-in user per request, resolved once by `handler()` so routes can read it synchronously.
const requestUser = new WeakMap<Request, string | null>();

/** The signed-in user's id (null if not signed in). Only valid inside `handler()`. */
export function userIdOf(req: Request): string | null {
  return requestUser.get(req) ?? null;
}

export function sessionTokenOf(req: Request): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

function isHttps(req: Request) {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}

/** HttpOnly so page scripts can't read it; SameSite=Lax so other sites can't post with it. */
export function sessionCookie(req: Request, token: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

export function clearSessionCookie(req: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`;
}

/** Refuse state-changing requests sent from another site's page. */
function checkSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))) {
    throw forbidden("Cross-site request refused");
  }
}

export async function jsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("BAD_JSON", "Request body must be valid JSON");
  }
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) {
    const message = e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    return Response.json({ error: { code: "VALIDATION", message, details: e.issues } } satisfies ApiError, { status: 400 });
  }
  if (e instanceof ServiceError) {
    return Response.json({ error: { code: e.code, message: e.message, details: e.details } } satisfies ApiError, { status: e.status });
  }
  if (e instanceof NotFoundError) {
    return Response.json({ error: { code: "NOT_FOUND", message: e.message } } satisfies ApiError, { status: 404 });
  }
  if (e instanceof RangeError) {
    return Response.json({ error: { code: "OUT_OF_RANGE", message: e.message } } satisfies ApiError, { status: 400 });
  }
  console.error(e);
  return Response.json({ error: { code: "INTERNAL", message: "Unexpected server error — see the server log" } } satisfies ApiError, { status: 500 });
}

/** Wrap a route handler: always dynamic, signed-in user resolved, JSON result (or a Response as-is), typed errors. */
export function handler<C = unknown>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    // Outside the try: during `next build` this rejects on purpose to stop prerendering,
    // and Next must see that rejection.
    await connection();
    try {
      checkSameOrigin(req);
      requestUser.set(req, await sessionUserId(sessionTokenOf(req)));
      const out = await fn(req, ctx);
      return out instanceof Response ? out : Response.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
