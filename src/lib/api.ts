// Route handler plumbing: error → JSON mapping, actor header, JSON body parsing.
// Routes stay thin: validate (zod, inside services) → call a service → return JSON.

import { connection } from "next/server";
import { ZodError } from "zod";
import { NotFoundError } from "@/lib/store";
import { badRequest, ServiceError } from "@/lib/services/common";

export const USER_HEADER = "x-user-id";

export function userIdOf(req: Request): string | null {
  return req.headers.get(USER_HEADER);
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

/** Wrap a route handler: always dynamic, JSON result, typed errors. */
export function handler<C = unknown>(fn: (req: Request, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    // Outside the try: during `next build` this rejects on purpose to stop prerendering,
    // and Next must see that rejection.
    await connection();
    try {
      return Response.json(await fn(req, ctx));
    } catch (e) {
      return errorResponse(e);
    }
  };
}
