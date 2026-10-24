"use client";

// Browser-side API helper: adds the selected user's id and turns error JSON into exceptions.

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

let currentUserId: string | null = null;

export function setApiUser(id: string | null) {
  currentUserId = id;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (currentUserId) headers["x-user-id"] = currentUserId;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new ApiClientError(0, "NETWORK", "Cannot reach the server — is `npm run dev` running?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
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
