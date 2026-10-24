"use client";

// Browser-side API helper: the session cookie goes along automatically; error JSON becomes exceptions;
// an expired session sends the user back to the sign-in page.

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function toSignIn() {
  const { pathname, search } = window.location;
  if (pathname === "/login" || pathname.startsWith("/t/")) return;
  const back = pathname + search;
  window.location.assign(back === "/" ? "/login" : `/login?next=${encodeURIComponent(back)}`);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError(0, "NETWORK", "Cannot reach the server — is `npm run dev` running?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401 && err?.code === "NOT_SIGNED_IN") toSignIn();
    throw new ApiClientError(res.status, err?.code ?? "HTTP_" + res.status, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiClientError) {
    const details = Array.isArray(e.details) && e.details.every((d) => d && typeof d === "object" && "reason" in d)
      ? " — " + (e.details as { code: string; reason: string }[]).map((d) => `${d.code}: ${d.reason}`).join("; ")
      : "";
    return e.message + details;
  }
  return e instanceof Error ? e.message : String(e);
}
