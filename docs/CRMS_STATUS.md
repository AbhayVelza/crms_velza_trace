# Velza CRMS (Barcode Traceability) — Current Status

Snapshot: 29 Oct 2026 · branch `develop/aditya` @ `67fb2df` (pushed to `origin/develop/aditya`) · `main` @ `2b04fa2` (Phase 16)

> Purpose of this file: give an external assistant enough context to write the **master prompt for the next phase of
> work**. It summarises what exists, what is verified, what is broken, and what is still undecided. Detailed sources in
> the repo: `WORKING_MODEL.md` (single source of truth + change log), `README.md`, `ASSUMPTIONS.md`, `SECURITY.md`,
> `docs/QA_REPORT.md`, `docs/SCALABILITY_REPORT.md`, `docs/MANUAL_QA_GUIDE.md`.

---

## 1. What the product is

A web app that gives every **case, tray and pack** of Velza beverages a unique code, prints barcode/QR stickers at the
plant, has QC verify them, and records every hand-over down the chain:

```
Manufacturer → Super Stockist → Distributor → Retailer
Manufacturer → Super Stockist → Retailer            (retailers assigned directly to an SS)
```

Velza HQ sees stock, status, location, full history, alerts and recalls. Consumers scan the QR to check a product is
genuine / not recalled (public page, no business data).

### Codes

| Unit | Contents | Code format | Example |
|---|---|---|---|
| Batch | one flavour, one run | 6 random chars, pre-issued to the plant PC (pool of 10, auto top-up) | `Y53RSN` |
| Case (lot) | 4 packs × 6 cans | country(2) + batch(6) + flavour(2) + hex lot no.(5) = 15 chars | `91Y53RSNOR00001` |
| Tray (lot) | 6 packs × 4 cans | same as case | `91Y53RSNOR00004` |
| Pack | 6 or 4 cans | lot code + pack size + sequence = 17 chars | `91Y53RSNOR0000161` |

Flavours: OR, GA, NS, MN. Lot numbers `00001`–`1869F` (≤ 99,999 per batch), never reused. Lot sticker 100×50 mm
(barcode + QR), pack sticker 75×25 mm (barcode).

**Continuing a batch (30 Oct 2026):** New print order → *Continue an existing batch* carries on from the batch's stored
counter (one counter per batch = per batch + flavour), e.g. Day 1 `00001`–`02710`, Day 2 from `02711`, on any online
PC of the plant. The batch keeps its dates and device. Exhausted (`1869F` used), recalled, unsynced and offline cases
are refused server-side. Retries with the same request key never allocate twice. Cap: 10,000 lots per order, 1,000 on
the JSON store (PostgreSQL is required for production volumes). Details: `WORKING_MODEL.md` → "Continuing a batch".

### Status lifecycle

`Generated → Printed → Packed (QC) → In transit → At SS / At DB / At Retailer → Opened (retailer only)`
Side states: `Quarantined` (QC mismatch → Void, or Reprint with reason → Printed → QC again), `Void`, `Damaged`
(any stock-holding tier, with reason, HQ alerted), `Recalled` (HQ recalls a batch).

### Roles (7, each with its own portal; server enforces everything)

| Role | ID format | Main screens |
|---|---|---|
| Velza Admin | AD0001 | Partners (registration), Sign-ins & passwords, Devices, Countries & flavours, Batch code pools, Settings |
| Velza HQ | HQ0001 | Dashboard, Search code (timeline), Alerts, Batches & recall, Scan audit |
| Manufacturer Operator | MF0001-OP | New print order, Print orders (+codes view), Dispatch, Reprint, Void, My stock, Damaged |
| Supervisor / QC | MF0001-QC | Verify, My stock |
| Super Stockist (one per state) | SS0001 | Receive, Dispatch, My stock, Damaged, My partners |
| Distributor | DB0001 | Receive, Dispatch, My stock, Damaged, My retailers |
| Retailer | RT0001 | Receive, Open lot, My stock, Damaged |
| Consumer | — | Public check page `/t/[code]` |

Visibility: SS sees only its distributors + its direct retailers; DB sees only its retailers; plant can dispatch to any SS.

Alerts: NOT_RECEIVED (in transit > 3 days, configurable), WRONG_RECEIVER, UNKNOWN_CODE, BLOCKED_CODE, damage.

---

## 2. Tech stack and architecture

| Layer | Detail |
|---|---|
| Framework | **Next.js 16.4.3** (App Router, Turbopack) — note: this version has breaking changes vs. older Next.js; agents must read `node_modules/next/dist/docs/` before writing code (see `AGENTS.md`). Middleware is `src/proxy.ts` |
| UI | React 19.3, TypeScript, Tailwind CSS 4, Open Sans (bundled), Velza Global brand tokens, light/dark/system themes, left sidebar shell |
| Validation | zod 4 |
| Barcodes / scanning | bwip-js (render), @zxing/browser (camera); USB/Bluetooth scanners work as keyboards |
| Layers | `src/app/api/*` route handlers (37 routes) → `src/lib/services/*` → `src/lib/core/*` (pure rules: codes, rules, alerts, permissions, ids, print plan) → `Store` interface (`src/lib/store`) |
| Storage | JSON file by default (`data/db.json`); **PostgreSQL** when `DATABASE_URL` is set (hand-written SQL, no ORM, schema v2, `db/schema.sql`, `npm run db:migrate`); embedded PGlite for tests |
| Auth | `velza_session` cookie (HttpOnly, SameSite=Lax, 12 h), scrypt hashes, 5-fail lockout for 5 min. `SIGN_IN=on/off`: **off by default under `npm run dev`** (opens on the Velza Admin portal as AD0001; the header's Role/User selects switch person, no password), on by default under `npm start` (unset, empty or misspelled = on). `npm start` also reads `.env.local` |
| Security | CSP + security headers, per-process in-memory rate limits, cross-site write protection, 256 KB body limit, append-only audit history |
| Tests | Vitest unit (JSON + PostgreSQL projects), Playwright 12-step browser demo, QA harness in `tests/qa/` |
| Side effects | None (no email/SMS/webhooks) |

DB tables: `partners`, `users`, `codes` (one row per sticker), `code_history` (append-only, one row per event/scan,
failed scans kept).

---

## 3. What has been built (history)

| Phase | Delivered | Where |
|---|---|---|
| 1–10 | Prototype: setup, core lib + tests, store + seed + API, role switcher, print wizard + sticker print views, QC verify, dispatch/receive/open lot/my stock, HQ dashboard/search/alerts/batches/recall/scan audit/public page, offline simulation + sync, mobile scan screens, Playwright demo | main |
| 11 | Database layer: PostgreSQL beside JSON | main |
| 12 | Partner registration, readable IDs (MF/SS/DB/RT/AD/HQ + 4 digits), sign-in | main |
| 13 | Generated-codes view per print order | main |
| 14 | Damaged stock, opened-case counts, quarantine recovery | main |
| 15 | Sign-in switch for development | main |
| 16 | Retailer chain without Suppliers (Outlet → Retailer; `db:convert-chain` migration) | main |
| UI `8393c95` | Velza Global brand redesign: tokens, logo, Open Sans, themes, icon set, sidebar, all 31 screens restyled | **develop/aditya only** |
| `67fb2df` | UI smoothness (skeletons, `useAction` double-submit guard, page fade, drawer focus trap); **DEF-002 scalability remediation** (filtered store reads, DEF-005 fix); QA harness + 18-partner Maharashtra dataset; QA/scalability/manual-QA reports | **develop/aditya only** |

| Batch continuation (30 Oct 2026, uncommitted) | Continue an existing batch from its persisted hex lot counter: `GET`/`POST /api/print-orders/continue`, read-only preview, idempotency key = print order ID, online-only, exhausted/recalled/unsynced/capacity checks, Exhausted badge on Batches. Reuses `nextLotNumber`, `allocateLots`, `formatLotNumber`; no schema change | **develop/aditya, uncommitted** |

| Audit fixes (30 Oct 2026, uncommitted) | Production always requires sign-in (F-01); seed refuses non-empty data, `--force` writes a backup first, never in production (F-02); unique device names per plant; no cross-partner status/existence leaks (F-09); readable validation errors; in-app delete dialog; inline-edit revert; no dev-users 404s; larger touch targets; plural/lot wording | **develop/aditya, uncommitted** |

**Not yet merged:** everything after Phase 16 is on `develop/aditya` (pushed), no PR into `main` yet.

---

## 4. Verified state (as of 28 Oct 2026)

| Check | Result |
|---|---|
| `npm run lint`, `npm run typecheck`, `npm run build` | Pass |
| Unit tests | 249/249 JSON project; 76/76 PostgreSQL project **when files run one at a time** (parallel PGlite start-up times out on the 8 GB dev PC — INFO-4) |
| `npm run test:e2e` (12-step browser demo) | 12/12 |
| Live API QA (sign-in ON) | 87 PASS, 1 FAIL (DEF-001), 1 needs decision (INFO-1) |
| Browser QA, all 7 roles | 64 PASS, 1 NOT RUN (no search/sort/paging exists) |
| Permission matrix | 126 live requests (7 roles × 18 APIs) all match `PERMISSIONS` |
| Partner registration via real UI | 48/48 checks, 18 partners, no defects |
| Batch continuation (30 Oct 2026) | Lint, typecheck, build pass; unit JSON 306/306 + PostgreSQL (PGlite) 103/103; e2e 12/12; HTTP smoke of `/api/print-orders/continue` on a throwaway copy. Continue screen not yet clicked through in a browser |
| Security | 401 without session, 403 out-of-role, refused writes don't mutate, deactivation kills sessions, CSRF/malformed/oversized bodies refused, public page leaks nothing |

QA dataset: 1 MF, 2 SS (Pune; Goa — one SS per state), 5 DB, 10 RT in `data/qa-mh-2026.json` (git-ignored; creds in a
git-ignored file — never put passwords in docs).

---

## 5. Scalability (measured, 100,000 code records, p95)

| | Lookup | HQ dashboard | Alerts | My partners | My stock | Writes |
|---|---:|---:|---:|---:|---:|---:|
| PostgreSQL after DEF-002 fix | **38 ms** (281 ms @10 clients, 0 errors) | **1,641 ms** (11 s @10 clients) | 111 ms | 147 ms | 74 ms | 17–202 ms |
| JSON after fix | 2,751 ms | 1,350 ms | 194 ms | 157 ms | 79 ms | 3.1 s |

Targets: lookup p95 ≤ 200 ms, dashboard ≤ 1 s. **Verdict: 100k not proven.** PostgreSQL meets lookup/lists/writes
sequentially; **dashboard still fails** (still loads every synced code to count stock per partner). JSON store cannot
scale by design (rewrites whole file per write). Target scale for go-live is **2 crore (20M) stickers**, never tested
beyond 100k. Still whole-table: HQ dashboard, batch list, scan audit (loads all to show latest 300).

---

## 4b. Verified state (4 Nov 2026)

Unit JSON 357 passed + 1 skipped; PostgreSQL (PGlite, serial) 140 passed + 3 skipped; lint, typecheck, build pass;
e2e 12/12; live API harness 101 PASS / 0 FAIL / 1 decision (INFO-1); management demo environment
(`C:\Users\ADMIN\velza-demo`, port 3400) built through the API 31/31 and browser-checked 873/873 (7 roles, every page,
4 widths). Print confirmation is now explicit (Print only opens the dialog; **Mark as printed** records it). Full
matrix, demo script and limitations: `docs/MANAGEMENT_DEMO.md`.

## 6. Open defects

| ID | Sev | Summary | Status |
|---|---|---|---|
| DEF-002 | P1 | Whole-table reads; dashboard/batch list/scan audit still too slow at 100k | Partly fixed; remainder: counts in DB, LIMIT/paging |
| DEF-001 | P3 | `GET /api/admin/settings` answered without sign-in (read-only config) | **Fixed 4 Nov 2026** (uncommitted): Velza Admin only; unit test + live API check |
| DEF-003 | P3 | With sign-in ON, every page logs a console 404 probing `/api/auth/dev-users` | **Fixed 30 Oct 2026** (uncommitted): no request when sign-in is on |
| DEF-004 | P3 | Partner table has no search/sort/pagination | Open |
| INFO-1 | — | PIN code not validated against state | Decision needed |
| INFO-3 | — | Partner names not unique (phone/email are) | Noted |
| INFO-4 | — | PGlite unit tests time out when run in parallel on low-RAM PCs | Cause known; vitest config change needs approval |
| UI minor | — | `/hq/alerts` flashes "No alerts" while loading; dashboard "Counts by status" has no empty state; inline-edit inputs in Partners table duplicate accessible names; dev PC on Node 22 while README asks Node 24 | Logged |

---

## 7. Known gaps (not built)

- **Real offline at the plant:** "Offline" is only a flag on the device record; an internet/server outage stops printing. Needs an on-site plant server + local DB syncing to cloud.
- **Correction flows after stock leaves the plant:** relabel a wrong sticker at SS/DB/RT, return to plant, cancel a mis-sent dispatch, correct a mistaken scan (history is immutable by design) — all need HQ-approved flows.
- **Returns / damaged-stock disposition:** damage reporting exists; no returns screen, no undo, no write-off/credit-note process.
- **Retail sales:** tracking ends at receipt/opening; no sale recording.
- **Batch continuation limits:** JSON store capped at 1,000 lots per continuation order and not suitable for full 99,999-lot batches; a 10,000-lot order takes ≈ 14 s on embedded PostgreSQL (not measured on a hosted server); no PC picker (operator screens use the plant's first PC); real multi-connection PostgreSQL contention covered by injected-error tests, not a live server.
- **Production infra:** no hosting yet, no managed PostgreSQL, no backups/standby, no zero-downtime deploy, rate limits per-process only, no `LIMIT`/paging on large lists, no load/soak/failure drills.
- **Sign-in**: switched ON and verified on 29 Oct 2026; **temporarily OFF on the dev PC since 30 Oct 2026** (`SIGN_IN=off` in `.env.local`) for testing: http://localhost:3000 opens the Velza Admin Overview, `/login` redirects there. **Development/testing only, never on a deployment**: everyone who reaches the app is Velza Admin. Re-enable with `SIGN_IN=on`. See `WORKING_MODEL.md` Part 5, "Sign-in temporarily off".
- **Local data (29 Oct 2026)**: `data/db.json` (JSON store, no `DATABASE_URL`) holds the 18 QA partners and 21 sign-ins. A re-seed at 12:02 IST wiped them ("Partners (0)"); they were restored from `data/qa-mh-2026.json`, keeping the new Admin/HQ passwords. **Re-seeded again on 30 Oct 2026 at 10:38 IST: live data now has 0 partners and 2 sign-ins (not restored yet).** **Wiped again on 30 Oct 2026 at 15:44 IST** by `npm run seed` typed in a PowerShell window (npm debug log + PowerShell history): partner MF0001 "vietnam_mnf", batch X1SYQ7 and its 5,000 unprinted lots were lost; no usable backup or shadow copy exists. The seed now refuses non-empty data unless `--force`, which writes a backup first (see the audit-fixes row above) — don't use it to recover a password.

---

## 8. Pending decisions (from `WORKING_MODEL.md` key notes)

| # | Topic | Decision needed |
|---|---|---|
| 1 | Sign-in | Built and verified; temporarily off on the dev PC (30 Oct 2026). When to switch it back on; approve the AUTH-1 fix; force password change at first sign-in; 2FA for Admin/HQ; whether `npm run seed` should refuse to wipe existing data without a `--force` flag |
| 2 | Hosting | Recommended AWS Mumbai: Lightsail + managed PostgreSQL (~₹2,800/mo pilot; ~₹6,300–8,900/mo full rollout with standby) — confirm provider, budget, backup schedule |
| 3 | Network access until sign-in | Office network / VPN / Cloudflare Access |
| 4 | Country code per plant | Country of manufacture or market? (vietnam_plant uses 91 today) |
| 7 | Who opens cases | Only retailers today — do DB/SS ever split cases? |
| 8 | End of chain | Record retail sales or stop at receipt? |
| 9 | Hardware | 2D USB scanner at plant QC table |
| 10 | Alert timing | Per-leg NOT_RECEIVED thresholds |
| 11 | Scale to 2 crore | Schedule scale work + load tests |
| 12 | Zero downtime at plant | Plant server, spare printer/scanner, downtime SOP |
| 13 | Post-plant corrections | Which flows to build, who approves |
| 15 | **Python backend** | Proposal (no code): FastAPI + SQLAlchemy 2 + psycopg 3 + Alembic + PostgreSQL, pytest + Locust, one Docker image for cloud and plant server; Next.js UI unchanged and forwards `/api`. 7 phases (foundation → sign-in/admin → plant → movement → HQ → scale & switch-over → plant server), est. 4–6 weeks + 1–2 weeks for one developer. Awaiting approval + owner |
| 16 | UI redesign | Open PR `develop/aditya` → `main`; keep/change sign-in tagline |
| 17 | QA findings | Approve DEF-001/DEF-002 fixes; decide INFO-1 |

---

## 9. Recommended next steps (ordered, per `WORKING_MODEL.md`)

1. Open a reviewed PR `develop/aditya` → `main` (UI redesign + smoothness + DEF-002 + QA harness); enable branch protection on `main`.
2. Finish DEF-002: HQ dashboard and batch-list counts computed in the database (GROUP BY), `LIMIT`/paging for scan audit, alerts and partner list (also closes DEF-004), partial index for in-transit units; re-benchmark on PostgreSQL at 1M with a separate client machine.
3. Small fixes: DEF-001 (protect settings GET — approval required), DEF-003 (skip dev-users probe when sign-in is on).
4. Decide INFO-1 and the PGlite test-timeout config (run PostgreSQL test files serially / raise hook timeout).
5. Decide the Python backend plan (go/no-go) before investing further in the TypeScript backend.
6. Production readiness: hosting + managed PostgreSQL with standby, backups + restore drill, `SIGN_IN=on`, `HTTPS_ONLY=1`, shared rate limiter, load/soak/failure drills, then a plant pilot.
7. Later: plant server for real offline, post-plant correction flows, returns, per-leg alert thresholds.

---

## 10. Working conventions any next prompt must respect

- Read `AGENTS.md`: Next.js 16 differs from older versions — consult `node_modules/next/dist/docs/` before writing code.
- Every change gets an entry in the **Change log** at the end of `WORKING_MODEL.md` and updates the affected section in place.
- Each developer works on `develop/<name>`; merge to `main` only via reviewed PR; data files (`data/*.json`) never committed.
- Don't change response shapes, permissions (`src/lib/core/permissions.ts`), partner scoping, audit events or business rules without explicit approval; authorization changes need approval.
- Keep selectors used by tests (`#scan-input`, `.sticker`, `data-testid`s, labels, button names) and the single `<nav>`.
- Definition of done: `npm run lint`, `npm run typecheck`, `npm test` (PostgreSQL files serially if needed), `npm run build`, `npm run test:e2e` 12/12; behaviour changes verified on both JSON and PostgreSQL stores.
- Never put passwords in docs, tickets or logs. `codes` + `code_history` must change together in one transaction; history is append-only.

Useful commands: `npm run dev`, `npm run seed`, `npm test`, `npm run test:e2e`, `npm run db:migrate`,
`npm run db:convert-chain`, `npm run clear-activity`, `node tests/qa/startQaServer.mjs`, `node tests/qa/perfGenerate.mjs`,
`node tests/qa/perfBench.mjs`.
