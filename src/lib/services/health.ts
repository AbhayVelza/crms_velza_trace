// GET /api/health: does this app process reach its storage? For load balancers, the Docker HEALTHCHECK, the deploy
// workflow and uptime monitors. No sign-in needed, so the answer says nothing else: no version, host, error text or
// schema detail, only { ok: true } or a 503 { ok: false }. The reason for a failure goes to the server log.

import { getStore } from "@/lib/store";

/** A check slower than this counts as down (the Docker HEALTHCHECK gives the whole request 5 s). */
export const HEALTH_TIMEOUT_MS = 3_000;

const NO_STORE = { "cache-control": "no-store" };

export async function health(timeoutMs = HEALTH_TIMEOUT_MS): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      getStore().ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer from the store within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.error(`[velza] health check failed: ${e instanceof Error ? e.message : String(e)}`);
    return Response.json({ ok: false }, { status: 503, headers: NO_STORE });
  } finally {
    clearTimeout(timer);
  }
}
