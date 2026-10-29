# Velza Traceability CRM — QA Report

**Run date:** 28 Oct 2026 · **Branch:** `develop/aditya` · **HEAD:** `8393c95` (Polish Velza CRM UI and role-based sidebar)
**Scope:** end-to-end QA of the current implementation: 7 roles, partner hierarchy, an 18-partner Maharashtra dataset,
partner lifecycle, traceability, security boundaries, UI, data integrity, and scalability to 100,000+ records.
Evidence files are in [`docs/qa/`](qa/); the scalability detail is in [SCALABILITY_REPORT.md](SCALABILITY_REPORT.md);
the step-by-step demo is in [MANUAL_QA_GUIDE.md](MANUAL_QA_GUIDE.md).

## 1. Executive summary

| Area | Result |
|---|---|
| 18-partner Maharashtra dataset | **Created and verified**: 1 MF, 2 SS, 5 DB, 10 RT through the real registration API; verified by the API and by reading the data file. One deviation forced by a business rule: SS-002 is in Goa (one Super Stockist per state). |
| Roles and permissions (7 roles × 18 APIs = 126 requests) | **PASS**: every response matches the permission map in `src/lib/core/permissions.ts`; data scope enforced server-side. |
| Hierarchy scoping | **PASS**: each SS and DB sees and can dispatch to exactly its assigned partners; cross-hierarchy dispatch refused. |
| Partner lifecycle and validation | **PASS** (create, read, update, deactivate, delete, 11 validation cases, concurrent duplicate). One open question: PIN code is not checked against the state (INFO-1). |
| Traceability (print → QC → plant → SS → DB → Retailer → open; HQ trace; public page; recall) | **PASS** |
| Security | **1 defect**: `GET /api/admin/settings` answers without signing in (DEF-001, P3). Everything else tested passed. |
| UI (sign-in form, 7 role sidebars, refused pages, reload, back/forward, sign-out, mobile drawer, public page) | **PASS** (64/64); text search, sorting and pagination do not exist (NOT RUN). |
| Regression suite | Lint, typecheck: pass. E2E 12/12 and production build: pass. Unit: every JSON-store test passes; embedded-PostgreSQL test files time out at start-up on this PC (environmental, also in the baseline). |
| **Scalability to 100,000+ records** | **FAIL — measured** on the JSON store: at 100k code records an exact lookup takes 4.3 s (target ≤ 200 ms) and the dashboard 9.2 s (target ≤ 1 s). PostgreSQL could not be load-tested here; code inspection shows the same whole-table reads (DEF-002, P1). |
| **DEF-002 remediation and re-test (later on 28 Oct 2026)** | **Partly resolved — measured on a real PostgreSQL 17.3 server for the first time.** At 100k, sequential p95: lookup 677 → **38 ms**, My partners 1,385 → **147 ms**, My stock 887 → **74 ms**, alerts 1,148 → **111 ms** (all meet targets); dashboard 11.8 s → **1.64 s (still FAIL)**. Under 10 concurrent clients lookups no longer fail (40 % serialization errors → 0) and the dashboard no longer times out, but several c10 targets still miss on this PC. JSON store still FAILS lookups/writes by design. **100k support is not proven.** Detail: §14 and SCALABILITY_REPORT.md Part A. |

**Release readiness:** suitable for continued development and team demos at prototype scale. **Not ready** for
production volume: the dashboard still misses its target at 100k and concurrency results are from one PC; sign-in must
be on, and DEF-001 should be fixed.

## 2. Environment

| Item | Verified value |
|---|---|
| Repository | `C:\Users\ADMIN\Desktop\crms_velza\crms_velza_trace`, branch `develop/aditya`, HEAD `8393c95`; only pre-existing change: `package-lock.json` (kept, untouched) |
| Runtime | Node.js v22.13.1 (the README asks for Node 24; install shows an engine warning, everything runs), npm 11.1.0, Windows 11, 8 GB RAM (0.6–1.6 GB free during the run) |
| App | Next.js 16.4.3 (Turbopack), React 19.3, TypeScript, Tailwind CSS 4.3, zod 4 |
| Store | JSON file store (`STORE=json`). No `.env.local`, no `DATABASE_URL`: no PostgreSQL server is connected. Embedded PostgreSQL (PGlite) is used only by the unit tests. |
| Tests | Vitest 5.0.5 (two projects: `json` and `postgres`), Playwright 1.64.1 on Microsoft Edge |
| External side effects | None found (no e-mail, SMS, webhooks or outbound calls in `src/lib` or `src/app/api`) |

**Isolation.** No QA write touched the developer's data or dev server:

- Live QA ran on a production build in an isolated copy of the repo (outside the repo, own `node_modules`), port
  3300, **sign-in ON**, data file `data/qa-mh-2026.json` (new, git-ignored).
- Benchmarks ran on port 3400 against generated files outside the repo.
- `data/db.json` checksum before and after: `ba695aa7a03b0e998d3a22a2af2be1db` (unchanged).
- Test passwords were generated randomly into `data/qa-mh-2026-credentials.json` (git-ignored); none appears in any
  report, log or manifest (checked).

## 3. Baseline and final checks

| Check | Command | Baseline (before any change) | Final |
|---|---|---|---|
| Lint | `npm run lint` | exit 0 | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 | exit 0 |
| Unit (2 projects) | `npm test` | exit 1 — 231 passed, 1 failed, 35 skipped; 4 PostgreSQL-project files: `Hook timed out in 10000ms` | exit 1 — 214 passed, 1 failed, 68 skipped; 8 PostgreSQL-project files: `Hook timed out in 10000ms`. All `json` tests pass. |
| New dataset test | `npx vitest run tests/unit/maharashtraDataset.test.ts` | — | `json`: 8/8 pass · `postgres` (run alone): 8/8 pass |
| Build + E2E | `npm run test:e2e` (builds, serves on 3100, own data) | exit 0 — **12/12 passed** (2.4 min) | not re-run: no application source changed after the baseline (only tests and docs were added) |
| Live API QA | `npx tsx tests/qa/qaRun.ts` | — | run 1 (creates data): 95 PASS, 7 FAIL, 1 NEEDS INVESTIGATION → 5 of the 7 were a wrong expectation in the test (see §5); run 2 (rerun, idempotent): **87 PASS, 1 FAIL (DEF-001), 1 NEEDS INVESTIGATION (INFO-1)** |
| Browser QA | `node tests/qa/qaUi.mjs` | — | **64 PASS, 0 FAIL, 1 NOT RUN** (search/sort/pagination do not exist) |

**About the unit-test failures.** Every failure is `Hook timed out in 10000ms` in a set-up hook of an
embedded-PostgreSQL test file; the failing set varies between runs (4 files in the baseline, 8 in the final run) and the
same files pass when run alone. This is start-up time of PGlite on this machine under memory pressure, not an assertion
failure. It was present before this QA work (also recorded on 27 Oct). It is an **environment issue**, not a product
defect; fixing it (a longer `hookTimeout`, or fewer PGlite files in parallel) is a test-configuration change that was
not made without approval.

## 4. Business model as implemented (from the code)

| Rule | Where | Verified by |
|---|---|---|
| Tiers `MANUFACTURER`, `SS`, `DB`, `RETAILER`; IDs `MF/SS/DB/RT` + 4 digits, issued in sequence, never reused | `src/lib/services/admin.ts` (`registerPartner`), `src/lib/core/ids.ts` | dataset IDs MF0001 … RT0010; RT counter at 14 after disposable records |
| Distributor → Super Stockist; Retailer → Distributor or Super Stockist; MF and SS have no parent | `ASSIGNED_TO` in `src/lib/core/rules.ts` | BAD_PARENT tests |
| No plant → SS link: any plant supplies any SS | `destinations()` in `src/lib/services/movement.ts` | plant destinations = both SS |
| **One Super Stockist per state** | `validatePartner` (`STATE_TAKEN`); DB index `partners_one_ss_per_state` | second Maharashtra SS refused |
| Phone (digits) and e-mail (case-insensitive) unique | `validatePartner` | DUPLICATE tests |
| Tier cannot change; assignments re-validated on edit | `updateEntity` (`TYPE_LOCKED`) | tests |
| No partner-code field; no pending/approved/rejected states (only Active/Inactive); no district field | schema | inspection |
| Partners with history or assigned partners cannot be deleted, only deactivated | `referencesTo` | lifecycle test |
| Admin-only partner management, checked on the server | `requireAction(actor, "admin")` | 403 for every other role |

## 5. Role-permission matrix (live, sign-in ON)

Each cell is the HTTP status the server returned (run 2, `docs/qa/qa-run-results.json`). Expected values come from
`PERMISSIONS`; every cell matched.

| API (GET) | ADMIN | HQ | OPERATOR | QC | SS | DB | RETAILER |
|---|---|---|---|---|---|---|---|
| `/api/admin/partners` | 200 | 403 | 403 | 403 | 403 | 403 | 403 |
| `/api/admin/users` | 200 | 403 | 403 | 403 | 403 | 403 | 403 |
| `/api/admin/devices` | 200 | 403 | 403 | 403 | 403 | 403 | 403 |
| `/api/admin/pools` | 200 | 403 | 403 | 403 | 403 | 403 | 403 |
| `/api/dashboard` | 403 | 200 | 403 | 403 | 403 | 403 | 403 |
| `/api/alerts` | 403 | 200 | 403 | 403 | 403 | 403 | 403 |
| `/api/scans` | 403 | 200 | 403 | 403 | 403 | 403 | 403 |
| `/api/batches` ¹ | 403 | 200 | 200 | 200 | 200 | 200 | 200 |
| `/api/lookup/<code>` | 403 | 200 | 403 | 403 | 403 | 403 | 403 |
| `/api/print-orders` | 403 | 403 | 200 | 403 | 403 | 403 | 403 |
| `/api/reprint` | 403 | 403 | 200 | 403 | 403 | 403 | 403 |
| `/api/devices` | 200 | 403 | 200 | 403 | 403 | 403 | 403 |
| `/api/stock` | 403 | 403 | 200 | 200 | 200 | 200 | 200 |
| `/api/my-partners` | 403 | 403 | 403 | 403 | 200 | 200 | 403 |
| `/api/dispatch` | 403 | 403 | 200 | 403 | 200 | 200 | 403 |
| `/api/damaged` | 403 | 403 | 200 | 403 | 200 | 200 | 200 |
| `/api/bootstrap` ² | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| `/api/auth/me` | 200 | 200 | 200 | 200 | 200 | 200 | 200 |

¹ By design (`listBatches`): HQ gets every synced batch; a partner sign-in gets only batches made by its own plant —
verified: SS, DB and Retailer get `[]`, the Operator only MF0001's batches. Run 1 expected 403 here (a wrong assumption
in the test, corrected before run 2; not a defect).
² Scoped: Admin and HQ get all partners; every other role gets only its own partner and devices (verified).

**Other role checks:** sign-in, `me`, sign-out and old-cookie reuse (401) per role; refused writes (create / edit /
delete partners) by HQ, Operator, SS, DB and Retailer → 403, records unchanged, nothing created; Retailer cannot trace
codes or list partners; non-admin cannot `PUT` settings (403). In the browser every role's sidebar matches
`src/lib/menu.ts` exactly, and another portal's page opened by URL shows "This page is not part of the … portal"
while its API refuses the data (the page shell itself is served to any signed-in user; the API is the security
boundary, as `RoleGate` documents).

## 6. Maharashtra dataset (18 partners)

| Tier | Expected | API | Data file | IDs |
|---|---:|---:|---:|---|
| Manufacturer | 1 | 1 | 1 | MF0001 (sign-ins MF0001-OP, MF0001-QC) |
| Super Stockist | 2 | 2 | 2 | SS0001 (Pune, MH), SS0002 (Panaji, **Goa**) |
| Distributor | 5 | 5 | 5 | DB0001–DB0003 → SS0001; DB0004–DB0005 → SS0002 |
| Retailer | 10 | 10 | 10 | RT0001–RT0010, two per distributor |
| **Total** | **18** | **18** | **18** | no duplicates, no broken parents, every sign-in present |

- Created through `POST /api/admin/partners` (the registration form's API) in run 1; run 2 found all 18 by their QA code
  and created nothing (idempotent).
- **Deviation:** two Super Stockists cannot both be in Maharashtra (`STATE_TAKEN`; tested and refused). SS-002 is in Goa,
  next to the Kolhapur and Solapur distributors it supplies; all other 17 records are in Maharashtra.
- QA code (e.g. `QA-MH-2026-DST-001`) is the start of each name, because IDs are issued by the app.
- Full list: [qa/maharashtra-test-data.md](qa/maharashtra-test-data.md).

## 7. Partner lifecycle and validation

All on disposable records (created and deleted again, so the 18 stay untouched).

| Test | Result |
|---|---|
| Refuses empty name, missing phone, bad e-mail, bad phone, 5-digit PIN, no state, unknown state, 101-char name, unknown tier, weak password, duplicate phone | PASS (each with its own error code) |
| Second Maharashtra SS; SS moving into a taken state; tier change; DB under a retailer; parent that doesn't exist | PASS (refused) |
| Status `"maybe"` refused; unexpected fields `id`, `createdBy` ignored | PASS |
| Two identical registrations at the same moment → one created, one `DUPLICATE` | PASS |
| Edit persists (re-read) | PASS |
| Deactivate → the partner's open session gets 401 at once, and it cannot sign in | PASS |
| Delete a partner with assigned partners → refused; delete a partner without history → removed with its sign-in | PASS |
| PIN from another state (Delhi 110001 on a Maharashtra partner) | **NEEDS INVESTIGATION** → accepted (INFO-1) |
| Malformed JSON (400), form-encoded body (415), body > 256 KB (413), cross-site `Origin` (403) | PASS |

## 8. Traceability, scans and audit

One print order (1 case Original + 1 tray Green Apple, 12 stickers) through the real APIs:

| Step | Result |
|---|---|
| Admin registers the plant PC → batch codes issued; operator previews and creates the order; 12 unique codes stored; marked printed | PASS |
| QC refuses a pack from another lot; confirms both lots → PACKED | PASS |
| Plant → SS-001 (invoice QA-INV-001); SS-002 trying to receive → WRONG_RECEIVER; SS-001 receives; receiving again refused | PASS |
| HQ recalls the Green Apple batch → dispatching its tray refused | PASS |
| SS-001 → SS-002's distributor refused; DST-001 → DST-002's retailer refused | PASS |
| SS-001 → DST-001 → RTL-001; retailer opens the case | PASS |
| HQ trace of the case: GENERATED → PRINTED → VERIFIED → DISPATCHED → RECEIVED ×3 → OPENED, each with the person | PASS |
| Pack trace shows its parent case; public QR page: "Genuine" for the case, "Recalled — do not consume" for the tray, no business data | PASS |
| Unknown code → UNKNOWN_CODE; `<script>` and SQL-style codes → safe JSON, no 500 | PASS |
| Scan audit holds failures too (WRONG_RECEIVER, UNKNOWN_CODE …); no API edits or deletes it (405) | PASS |
| Dashboard lot total equals the lots in the data file | PASS |

Camera scanning needs a physical camera and HTTPS; it was not tested (scanners act as keyboards and use the same scan
box, which was tested). Real printers and barcode guns: not tested.

## 9. UI and regression

`tests/qa/qaUi.mjs` (Edge, 1440 × 900 and 390 × 844, sign-in ON): sign-in form, exact sidebar per role, refused page
by URL, current-item highlight, no sideways scrolling, reload keeps session and page, back/forward, no console errors
except the known probe (DEF-003), sign-out ends the session, partner filters on the QA dataset, mobile drawer,
public QR page — **64 PASS**. The 12-step E2E demo (`npm run test:e2e`) — **12/12**. Theme switching, sidebar collapse
and keyboard behaviour were verified in the redesign passes of 27–28 Oct (see WORKING_MODEL.md Part 3) and are not
re-claimed here.

## 10. Data integrity (QA data file, read only)

PASS: no orphan partners, sign-ins, packs or locations; every parent is an allowed tier; no duplicate IDs; no
pre-existing sign-in removed. The JSON store has no database constraints of its own (rules are enforced in the
services); the PostgreSQL schema (`db/schema.sql`) adds primary keys, foreign keys, the one-SS-per-state unique index,
a unique e-mail index and code-format checks — not exercised live here (no PostgreSQL server).

## 11. Defects and findings

| ID | Severity | Finding |
|---|---|---|
| DEF-002 | **P1 — High** | Lookups, dashboard and stock screens read whole tables; at 100k code records lookups take 2.6–4.3 s and the dashboard 9.2 s (60 s timeouts under 10 concurrent users). Blocks go-live at scale. **Remediated in part (§14): whole-table reads removed from lookup, alerts, My partners, My stock and 7 other paths; dashboard still over target at 100k.** |
| DEF-005 | **P2 — Medium** (PostgreSQL only) | Found in the DEF-002 re-test: concurrent HQ lookups of a code abort each other on a PostgreSQL server (`40001` serialization failures: 30–53 % of 10 concurrent lookups). **Fixed** in the same change (§14). |
| DEF-001 | P3 — Low | `GET /api/admin/settings` has no sign-in or role check. |
| DEF-003 | P3 — Low | With sign-in ON every page logs a console 404 (`/api/auth/dev-users` probe). |
| DEF-004 | P3 — Low | Partner table: no text search, sorting or pagination; returns every partner (667 KB at 2,018 partners). |
| INFO-1 | INFO | PIN code is not checked against the state. |
| INFO-2 | INFO | One-SS-per-state prevents two Maharashtra SS (business rule, working as designed). |
| INFO-3 | INFO | Partner names are not unique (only phone/e-mail are). |
| INFO-4 | INFO | Embedded-PostgreSQL unit tests time out at start-up on this PC. **Cause established (§14):** parallel PGlite start-up exceeds the 10 s hook timeout; all pass one file at a time. |
| INFO-5 | INFO | Node 22 in use; README requires Node 24. |

### DEF-001 — Admin settings readable without signing in (P3)
- **Workflow / role:** any visitor, no session.
- **Steps:** `curl http://<host>/api/admin/settings` without a cookie.
- **Expected:** 401 (like every other admin API).
- **Actual:** 200 with `notReceivedThresholdDays, demoMode, demoThresholdMinutes, lotSticker, packSticker, publicBaseUrl, poolIssueSize, poolRefillBelow, defaultCountry`.
- **Evidence:** `docs/qa/qa-run-2.log` ("Admin settings are not readable without signing in"); `src/app/api/admin/settings/route.ts` → `handler(() => getSettings())`; unchanged since Phase 3.
- **Impact:** configuration disclosure only (no credentials, no partner data). Writes (`PUT`) are protected (403 for non-admin, verified).
- **Fix (needs approval — authorization change):** `export const GET = handler((req) => getSettingsFor(userIdOf(req)))` with `requireAction(actor, "admin")`; the only caller is the Admin Settings page.
- **Regression test:** anonymous and non-admin `GET` → 401/403; Admin → 200.

### DEF-002 — Whole-table reads make key screens slow at volume (P1)
- **Workflow / role:** HQ trace, public QR check, HQ dashboard and alerts, SS/DB "My partners", My stock, every write on the JSON store.
- **Steps:** `node tests/qa/perfGenerate.mjs --codes 100000 …`, start the server on that file, `node tests/qa/perfBench.mjs …`.
- **Expected (provisional targets):** lookup p95 ≤ 200 ms, dashboard p95 ≤ 1 s.
- **Actual (100k code records, sequential):** case lookup p50 4.3 s / p95 5.6 s; dashboard p50 9.2 s / p95 10.6 s; at concurrency 10 the dashboard hit the 60 s client timeout.
- **Evidence:** `docs/qa/perf-1k.json`, `perf-10k.json`, `perf-100k.json`; `src/lib/services/trace.ts:47` (`tx.movements.list()` — the whole ledger — for one code), `dashboard()` (stock per partner × every lot and pack); 19 unfiltered `.list()` calls on lots, packs, movements and scans in `src/lib/services`.
- **Impact:** response times grow linearly with total data; the JSON store also rewrites the whole file on each write.
- **Fix:** see SCALABILITY_REPORT.md §6 (filtered queries using the existing indexes, SQL aggregates for the dashboard, PostgreSQL in production).
- **Regression test:** rerun `perfBench.mjs` at 100k on PostgreSQL; targets in SCALABILITY_REPORT.md §2.
- **Status (later on 28 Oct):** partly remediated and re-measured — see §14.

### DEF-003 — Console 404 on every page when sign-in is ON (P3)
- **Steps:** sign in with `SIGN_IN=on`, open any page, open the browser console.
- **Actual:** `Failed to load resource: 404` for `/api/auth/dev-users` on each page load (the header asks whether sign-in is off and treats 404 as "on" — `useDevUsers` in `src/components/ActAs.tsx`).
- **Impact:** noise in the console and the server log; hides real errors. No functional effect.
- **Fix:** read `/api/auth/mode` (already exists) first, and call `dev-users` only when `signInRequired` is false.
- **Regression test:** `qaUi.mjs` already counts these; expect 0.

### DEF-004 — Partner table has no search, sort or pagination (P3)
- **Actual:** `/admin/partners` renders every partner with inline editors; filter by "Show" only (by SS, by DB, unassigned). At 2,018 partners the API returns 667 KB (51 ms server-side).
- **Fix:** server-side search and paging when partner counts grow; not needed at current size.

### INFO-1 — PIN code not matched to the state
A Maharashtra partner with Delhi's PIN 110001 is accepted; only the 6-digit format is checked. Decide whether PIN
prefixes should be validated per state (a business rule; not changed).

## 12. Blocked or not tested

| Area | Status | Why / what is needed |
|---|---|---|
| PostgreSQL performance and constraints live | ~~BLOCKED~~ **Run in the DEF-002 re-test** (§14) | A private PostgreSQL 17.3 cluster on this PC; 1k/10k/100k imported and benchmarked; the generated data passed every schema constraint once batches got print orders. Still not run: 1M+, separate client machine, soak. |
| Load beyond concurrency 10, soak, failure drills | NOT RUN | Needs a dedicated machine; this PC had < 1.7 GB free. |
| Camera, printers, barcode guns, phones over HTTPS | NOT RUN | Hardware and HTTPS host needed. |
| Text search, sorting, pagination | NOT RUN | Not implemented (DEF-004). |
| District fields, approval workflow | NOT APPLICABLE | Not in the data model. |

## 13. Recommendations

1. Fix DEF-002 before any volume pilot (SCALABILITY_REPORT.md §6), then re-measure on PostgreSQL at 100k and 1M.
2. Fix DEF-001 (small, needs approval) and DEF-003.
3. Switch sign-in ON for any shared environment (key note 1 in WORKING_MODEL.md).
4. Decide INFO-1 (PIN/state) and whether PIN-prefix validation is wanted.
5. Give the PostgreSQL unit-test project a longer hook timeout or run its files one at a time, so `npm test` is green on
   developer PCs (test configuration; needs approval).

## 14. DEF-002 remediation and re-test (28 Oct 2026, later the same day)

Application code changed for DEF-002 only (store "any of" filter and filtered reads in the services). Nothing
committed. Full detail, tables and evidence: [SCALABILITY_REPORT.md](SCALABILITY_REPORT.md) Part A and
[`docs/qa/def-002/`](qa/def-002/).

**Root causes confirmed in the source:** lookup read the whole movement and reprint ledgers (`trace.ts:47`, `:93`);
dashboard and My partners ran `stockCounts()` once per partner over every lot and pack, and the dashboard re-read
everything through `alerts()`; alerts read every lot, pack and scan; My stock read every lot and pack; batch list
filtered every lot per batch; six more paths read whole tables. On PostgreSQL the lookup's read and its audit insert in
one `SERIALIZABLE` transaction made concurrent lookups abort (DEF-005).

**Files changed:** `src/lib/store/Store.ts`, `jsonStore.ts`, `sql/sqlStore.ts`; `src/lib/services/trace.ts`
(`lookup`, `names`, `alerts`, `dashboard`, `myStock`, `listBatches`, `batchReport`, `recallReport`),
`movement.ts` (`myPartners`), `damage.ts` (`listDamaged`), `printOrders.ts` (`createPrintOrder`, `codesForOrder`),
`admin.ts` (`referencesTo`). Response contracts, permissions, scoping, sync visibility, audit events and business rules
unchanged; one intended difference: a lookup's audit scan is written right after (not in the same transaction as) its read.

**Checks after the change**

| Check | Command | Result |
|---|---|---|
| Lint | `npm run lint` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Unit, JSON project (incl. store contract on JSON **and** PGlite) | `npx vitest run --project json` | **18 files, 249 tests passed** |
| Unit, PostgreSQL project | `npx vitest run --project postgres --no-file-parallelism` | **7 files, 76 tests passed** |
| Unit, both projects in parallel (`npm test` behaviour) | `npx vitest run <4 files>` | PostgreSQL files: `Hook timed out in 10000ms` (INFO-4, cause below); JSON all pass |
| New regression tests | `tests/unit/scalability.test.ts` (20), `store.contract.test.ts` (+1) | pass on both stores; against the old code the 9 read-assertion tests fail as intended |
| Old-vs-new differential, enriched 10k data | one-off script (not committed) | 104/105 answers identical; 1 differs only in an "in transit for …" age label |
| Production build + browser E2E | `npx playwright test` (runs `npm run build`) in an isolated copy of the working tree | **12/12 passed** (2.9 min) |
| Benchmarks | `tests/qa/perfBench.mjs` at 1k/10k/100k, JSON and PostgreSQL 17.3, before and after | SCALABILITY_REPORT.md A5 |

Role access, hierarchy, traceability and audit after the change: the regression tests assert 401/403 for each wrong
role on lookup, dashboard, alerts, My partners and My stock; that an SS/DB sees only its own partners; unsynced codes
stay invisible; every lookup (found or not, concurrent or not) writes its `LOOKUP` scan; and the E2E demo (12 steps
across all roles) passes. The live API and browser QA scripts (`qaRun.ts`, `qaUi.mjs`) were not re-run.

**Embedded-PostgreSQL timeouts (INFO-4) — cause established.** Measured on this PC: one PGlite start takes ≈ 3.1 s
alone and ≈ 12 s when 4 start at once, and loading the sample network ≈ 2.6 s / 8.5 s, so a PostgreSQL test file's
`beforeAll` needs ≈ 6 s alone but ≈ 20 s when vitest runs files in parallel — over the 10 s default hook timeout. Not
a product defect. Test configuration was not changed (proposal P6 in SCALABILITY_REPORT.md).

**Verdict:** see SCALABILITY_REPORT.md A1 — on PostgreSQL at 100k the lookup, filtered lists, partner hierarchy and
writes meet the sequential targets; the dashboard does not (p95 1.64 s); concurrency-10 targets mostly miss on this PC;
the JSON store fails by design. **100,000-record support is not proven.**

**Not changed, need separate approval:** DEF-001 (settings access), INFO-1 (PIN/state), the one-SS-per-state rule,
the test configuration (P6), the dashboard aggregation API (P1), pagination (P2), new indexes (P3).
