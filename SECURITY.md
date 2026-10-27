# Security

How the Velza Traceability app is protected, and what has to be set up around it when it goes on a server.
Security comes in layers: the app protects itself (part 2), but the network in front of it (part 3) is just
as important.

## 1. Sign-in

> **While developing, sign-in is off** under `npm run dev` (anyone who opens the app picks who to act as). It is on
> by default in a production build (`npm start`); `SIGN_IN=on|off` forces it. **Never run with `SIGN_IN=off`
> where people outside the development team can reach the app.**

Everyone signs in with the sign-in ID and password Velza Admin gave them (`DB0001`, `MF0001-OP`, `AD0001` …)
and reaches only their own portal; every API call checks who is signed in and what their role may do.

- Passwords are stored as scrypt hashes (never in plain text); nobody, including Velza Admin, can read one back.
- The session is an HttpOnly, SameSite=Lax cookie (Secure over HTTPS) that lasts 12 hours; the server keeps only
  a SHA-256 of it, so a copy of the database can't be used to sign in.
- 5 wrong passwords lock that sign-in ID for 5 minutes. A wrong ID and a wrong password give the same answer.
- Deactivating a sign-in or its partner stops it on the next request; a new password from Velza Admin signs the
  person out everywhere.
- Before going live: change the two first passwords (`AD0001`, `HQ0001`), or set `VELZA_ADMIN_PASSWORD` /
  `VELZA_HQ_PASSWORD` before the first start, and share partner passwords person to person (not by group chat).
- The only page meant for the public is the QR page `/t/<code>` (and the `/api/lookup/<code>?view=public` call
  it makes); it needs no sign-in and shows only status and product details.

## 2. What the app does itself

| Layer | Protects against | Where |
|---|---|---|
| **Content Security Policy**: pages may only run and load this site's own code; no plugins, no foreign scripts, styles, images or connections | Script injection (XSS), data being sent to other sites | `next.config.ts` |
| **No framing** (`frame-ancestors 'none'`, `X-Frame-Options: DENY`) | Clickjacking: another site hiding the app in a frame and tricking clicks | `next.config.ts` |
| **Other security headers**: `nosniff`, strict referrer, camera allowed only for this site, cross-origin isolation, no `X-Powered-By` | File-type tricks, leaking addresses, other sites using the camera, framework fingerprinting | `next.config.ts` |
| **HTTPS enforcement** (HSTS + upgrade insecure requests) when `HTTPS_ONLY=1` | Eavesdropping and downgrade to plain HTTP | `next.config.ts` |
| **Cross-site write block**: any change (POST/PATCH/DELETE) coming from another website's page is refused | Cross-site request forgery (CSRF) | `src/lib/security.ts` |
| **JSON only, max 256 KB** per request | Form-based CSRF, memory exhaustion with huge requests | `src/lib/api.ts` |
| **Rate limits** (per minute): 1,200 requests per client, 600 changes per client, 120 public QR lookups per client, 12,000 for all clients together | Floods / DoS, guessing codes on the public page, scripted abuse | `src/lib/security.ts` |
| **Sign-in**: hashed passwords, hashed session tokens, HttpOnly cookie, lockout after 5 wrong passwords, re-checked on every request | Password theft, session theft, guessing | `src/lib/services/auth.ts`, `src/lib/passwords.ts` |
| **Input validation**: every request body is checked against a schema; codes are parsed, never trusted; database queries only use parameters (`$1`), never text pasted into SQL | Injection (incl. SQL injection), malformed data | `src/lib/services/*`, `src/lib/core/codes.ts`, `src/lib/store/sql` |
| **Role checks on every API call**, and each partner sees only its own data | A screen being bypassed by calling the API directly with another role or partner | `src/lib/core/permissions.ts`, `src/lib/services/*` |
| **No internal details in errors**: unexpected errors return a generic message; details go to the server log only | Information leaks | `src/lib/api.ts` |
| **Demo helper switched off in production** (screen and `/api/demo-codes`) | Listing real codes | `src/app/api/demo-codes/route.ts` |
| **Security log**: every blocked request is logged as `[security] <time> <reason> ip=… <method> <path>` | Spotting attacks | server log |
| **Append-only history**: movements, scans and reprints are never edited or deleted (in PostgreSQL a trigger refuses it); every scan, including failures, is recorded | Tampering with the trace record | `src/lib/store`, `db/schema.sql` |
| **Data rules in the database**: a code must match its parts, a partner ID must match its tier, one Super Stockist per state, linked rows must exist | Bad data from bugs or manual edits | `db/schema.sql` |
| **Dependency check**: `npm audit` reports 0 known vulnerabilities (Oct 2026) | Known holes in libraries | run `npm audit` |

## 3. What to set up around the app (network layers)

```
Phones / PCs / scanners ──HTTPS──▶ Cloudflare (WAF, DDoS, Access) ──HTTPS──▶ Reverse proxy ──▶ App (port 3000, private) ──▶ Database (private)
```

1. **HTTPS everywhere.** Put a reverse proxy (Caddy, Nginx or IIS) or Cloudflare in front of the app with a
   real certificate. Then set `HTTPS_ONLY=1`. HTTPS is also what lets phones use the camera to scan.
2. **Real client IP for the rate limits.** The proxy must pass the visitor's real IP in a header it controls,
   and the app must be told which one: `CLIENT_IP_HEADER=cf-connecting-ip` (Cloudflare) or
   `CLIENT_IP_HEADER=x-real-ip` (Nginx with `proxy_set_header X-Real-IP $remote_addr;`). Without this, a
   client can fake its IP and only the global limit applies.
3. **Firewall.** Open only port 443 (HTTPS) to the outside. The app's own port (3000) must be reachable only
   from the proxy (bind to `127.0.0.1` or block it). Never expose the database port. No open RDP/SSH to the
   internet; use a VPN for administration.
4. **WAF and DDoS protection.** Cloudflare (free plan is a good start) or the hosting provider's equivalent:
   managed WAF rules, bot protection, DDoS absorption.
5. **Admin pages from known places only** (recommended): put `/admin/*` behind Cloudflare Access or a VPN, so
   a stolen Admin password alone isn't enough. Everything else is protected by sign-in.
6. **Database.** On a private network only (or the provider's private networking / IP allow-list), with SSL
   (`?sslmode=require`), encrypted at rest, with **daily backups kept off the server** and a tested restore.
   Run `npm run db:migrate` once as the database owner; the app itself can then use a user that may only
   read and write rows (`SELECT, INSERT, UPDATE, DELETE` on the tables, `USAGE` on their sequences), not create
   or drop tables. Keep `DATABASE_URL` only in `.env.local` / the server's environment, never in git.
   Without a database the data is in `data/db.json`; it is never served to browsers, but back it up the same way.
7. **Server hygiene.** Automatic OS security updates, the app running as a normal (non-admin) user,
   antivirus on Windows, secrets only in environment variables (never in git).
8. **Monitoring.** Collect the server log and alert on bursts of `[security]` lines and on HTTP 5xx errors.
   HQ's **Alerts** and **Scan audit** screens show suspicious scans (unknown codes = possible counterfeits,
   wrong receivers, blocked codes).
9. **Updates.** Run `npm audit` and update dependencies monthly, and after any security advisory for Next.js.
10. **Devices in the field.** Phones and PCs that use the app should have a screen lock and current updates;
    scanners in keyboard mode need nothing else.

## 4. Settings

| Environment variable | Default | Meaning |
|---|---|---|
| `SIGN_IN` | off in `npm run dev`, on in `npm start` | `on`: sign-in ID + password. `off`: pick who to act as, no password (development only) |
| `DATABASE_URL` | — | PostgreSQL connection string (secret). Unset = JSON file |
| `VELZA_ADMIN_PASSWORD`, `VELZA_HQ_PASSWORD` | random | First passwords of `AD0001` / `HQ0001` on a clean start (secret) |
| `HTTPS_ONLY` | off | `1` when served over HTTPS: adds HSTS and upgrade-insecure-requests |
| `CLIENT_IP_HEADER` | — | Header with the real client IP set by your proxy (`cf-connecting-ip`, `x-real-ip`) |
| `RATE_LIMIT_PER_MIN` | 1200 | Requests per minute per client |
| `RATE_LIMIT_WRITES_PER_MIN` | 600 | Changes (scans, dispatch, admin edits) per minute per client |
| `RATE_LIMIT_PUBLIC_PER_MIN` | 120 | Public QR lookups per minute per client |
| `RATE_LIMIT_GLOBAL_PER_MIN` | 12000 | All requests per minute, all clients together |

Rate limit counters live in the server's memory: they reset when the server restarts and apply per server.
With several servers, move them to a shared store (e.g. Redis) or rely on the WAF's rate limiting.

## 5. Next steps

1. An **audit log of admin changes** (who registered, changed or deactivated which partner or sign-in, when).
2. Optional: force a password change at first sign-in, and two-factor sign-in for Velza Admin and HQ.
3. A stricter CSP with per-request nonces, so inline scripts are no longer allowed.
4. A penetration test before going live on the internet.
