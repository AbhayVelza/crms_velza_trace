// Request-level protection shared by every API route: client IP, rate limits, size and origin checks.
// Pure helpers (no Next imports) so they can be unit tested; `handler()` in api.ts applies them.

/** Fixed-window counter per key. Keeps memory bounded by dropping expired windows. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    private readonly maxKeys = 50_000,
  ) {}

  /** Count one request; returns seconds to wait when over the limit, or 0 when allowed. */
  take(key: string, now = Date.now()): number {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Still full (a flood of distinct keys): start over rather than grow without bound.
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** Requests per minute. Generous per client because a whole shop or office often shares one IP. */
export const LIMITS = {
  perClient: num(process.env.RATE_LIMIT_PER_MIN, 1200),
  writesPerClient: num(process.env.RATE_LIMIT_WRITES_PER_MIN, 600),
  publicPerClient: num(process.env.RATE_LIMIT_PUBLIC_PER_MIN, 120),
  /** All clients together: a backstop that a spoofed client IP can't get around. */
  global: num(process.env.RATE_LIMIT_GLOBAL_PER_MIN, 12_000),
};

export const MAX_JSON_BYTES = 256 * 1024;

/**
 * Client IP for rate limiting. Behind a reverse proxy set CLIENT_IP_HEADER to the header that proxy
 * overwrites (e.g. "cf-connecting-ip" for Cloudflare, "x-real-ip" for Nginx); a client can't fake it then.
 * Without one, the RIGHTMOST X-Forwarded-For entry is used (the hop nearest this server, added by Next or the
 * proxy); the leftmost entries are whatever the client sent. It can still be faked by a direct client, which is
 * why the global limit also exists and why production warns once when CLIENT_IP_HEADER is unset.
 */
export function clientIp(headers: Headers, trustedHeader = process.env.CLIENT_IP_HEADER): string {
  const trusted = trustedHeader ? headers.get(trustedHeader.toLowerCase()) : null;
  if (!trustedHeader) warnUntrustedIpOnce();
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const raw = trusted ?? hops[hops.length - 1] ?? "";
  return raw.trim().slice(0, 64) || "unknown";
}

let warnedUntrustedIp = false;
function warnUntrustedIpOnce() {
  if (warnedUntrustedIp || process.env.NODE_ENV !== "production") return;
  warnedUntrustedIp = true;
  console.warn("[security] CLIENT_IP_HEADER is not set: per-client rate limits and sign-in lockout use X-Forwarded-For, which a client can spoof. Set it to your proxy's client-IP header.");
}

/**
 * State-changing requests must come from this site's own pages. Browsers send Sec-Fetch-Site and Origin;
 * scripts and scanners that send neither are allowed (they can't ride on a user's browser).
 */
export function isCrossSiteWrite(method: string, headers: Headers): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (headers.get("x-forwarded-host") ?? headers.get("host"));
  } catch {
    return true;
  }
}

/** One line per blocked request, so attacks show up in the server log. */
export function logSecurityEvent(reason: string, req: Request, ip: string) {
  const path = new URL(req.url).pathname;
  console.warn(`[security] ${new Date().toISOString()} ${reason} ip=${ip} ${req.method} ${path}`);
}
