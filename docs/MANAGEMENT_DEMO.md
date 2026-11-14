# Velza Traceability CRM — Management Demonstration Package

4 Nov 2026 · branch `develop/aditya` (uncommitted work on top of `511c706`) · prepared by Claude Code

This package covers the senior-management demonstration: what works (with the evidence), the walkthrough script,
the demo sign-ins, the architecture, the limitations and how to start the demo. Every status below comes from a test
that was actually run on 4 Nov 2026; nothing is marked WORKING because a screen or menu item exists.

**The demo runs in its own workspace, `C:\Users\ADMIN\velza-demo`**: its own copy of the app (production build), its
own data file, its own passwords and port **3400** (bound to 127.0.0.1, not reachable from other machines). It never
touches `data/db.json` or the app on port 3000.

Contents: [A. Functionality matrix](#a-system-functionality-matrix) · [B. Demo script](#b-management-demo-script-3045-min)
· [C. Demo sign-ins](#c-demo-user-credential-register) · [D. Architecture](#d-system-architecture-summary)
· [E. Known limitations](#e-known-limitations) · [F. Startup guide](#f-demo-startup-guide) · [Evidence](#evidence)

---

## A. System functionality matrix

Evidence keys: **U** = unit/service tests (`npm test`, JSON store 357 passed / 1 skipped; PostgreSQL-PGlite 140 passed /
3 skipped) · **E2E** = Playwright browser script, 12/12 · **API** = live API harness `tests/qa/qaRun.ts`, 101 PASS /
0 FAIL / 1 decision · **DS** = demo build-up through the API `tests/qa/demoSetup.ts`, 31/31 · **UI** = browser check of
every page of every role at 4 widths `tests/qa/demoUi.mjs`, 873/873.

| Module | Feature | Role | Expected behaviour | Actual result | Status | Limitations |
|---|---|---|---|---|---|---|
| Admin | Register Manufacturer / SS / Distributor / Retailer, IDs issued (MF0001, SS0001 …) | Admin | Partner + sign-in(s) created; plant gets -OP and -QC | API 11/11 dataset, DS 4/4, E2E step 11 | WORKING | — |
| Admin | Hierarchy: DB under SS; Retailer under DB or directly under SS | Admin | Parent stored; children visible only to their parent | API Hierarchy 7/7, DS, U `access.test.ts` | WORKING | No stored Manufacturer→SS link: any plant may supply any SS (by design) |
| Admin | One SS per state | Admin | Second SS in a state refused | API (STATE_TAKEN) | WORKING | — |
| Admin | Duplicate phone / e-mail refused; concurrent duplicate registration | Admin | One record only | API Concurrency 1/1, DS | WORKING | Names are not unique (INFO-3) |
| Admin | PIN code validation | Admin | 6-digit format | API | PARTIALLY WORKING | PIN is not checked against the state (INFO-1, decision needed) |
| Admin | Edit, deactivate, delete partner | Admin | Edit persists; deactivation ends sessions; partners in use can't be deleted | API Lifecycle 4/4, U | WORKING | — |
| Admin | Sign-ins & passwords, Devices, Countries & flavours, Batch code pools | Admin | CRUD with validation, in-app delete confirmation | U `adminDevices`, `access`; UI pages 4 widths | WORKING | — |
| Admin | Settings (alert threshold, sticker sizes, public URL) | Admin | Admin only | U `access` (new), API now PASS | WORKING | **Fixed today (DEF-001)**: was readable without signing in |
| Admin | Partner search / sort / paging | Admin | — | Only a "Show" filter by type/parent | NOT IMPLEMENTED | DEF-004 |
| Manufacturer | Manufacturer dashboard / profile page | — | — | No such screens; the plant uses Operator and QC portals, HQ has the dashboard | NOT IMPLEMENTED | Not in scope of the current design |
| Manufacturer | Device registration | Admin | Plant PCs registered by Admin | DS (2 PCs), U | WORKING | Plant cannot register its own PC (Admin task by design) |
| Operator | New print order: flavour, dates, cases/trays → batch codes from pool, lots, packs | Operator | 1 lot + 4 packs per case, 1 + 6 per tray; codes from the PC's pool | E2E step 1 (24 stickers), DS (34 stickers), U | WORKING | — |
| Operator | Barcode / QR rendering | Operator | Every sticker decodes back to its code | E2E step 1 decodes all 24 barcodes and 4 QR codes | WORKING | Not tested on a physical label printer |
| Operator | Print view, label-roll / A4 | Operator | Preview at real size; Print opens the browser dialog only | E2E, UI | WORKING | Physical printing NOT TESTED (no printer) |
| Operator | Explicit print confirmation (**Mark as printed**) | Operator | Only this records PRINTED; atomic; idempotent; never from dialog/CSV/navigation | U 13 tests (incl. injected failure rollback), E2E (no request on Print/CSV; double-click → 1 request), DS | WORKING | Hardened today |
| Operator | Print orders list: PRINTING PENDING / PRINTED with time, Finish printing | Operator | Pending orders visible and reopenable | UI, E2E | WORKING | Added today |
| Operator | Codes view + CSV export | Operator | CSV of every code; records nothing | E2E (download), U | WORKING | — |
| Operator | Continue an existing batch | Operator | Carries on from the stored counter; no reuse; exhausted/recalled/unsynced/offline refused; idempotent | U `continuation.test.ts` (26 per store), DS (continued on PC-2 from 00007) | WORKING | Operator screens use the plant's first PC (no PC picker); JSON store capped at 1,000 lots per continuation |
| Operator | Reprint (same code, reason logged) | Operator | No new code, history logged | E2E step 9, U `quarantine`, `printConfirmation` | WORKING | — |
| Operator | Void lot | Operator | VOID for good, never reused; QC refuses it | U `printConfirmation`, `quarantine` | WORKING | — |
| Operator | Offline device + sync | Operator | Offline creates unsynced codes; dispatch blocked until sync | E2E step 8 | WORKING | Simulation only: a real network outage stops the app (no plant server) |
| QC | Verify lot then each pack, confirm → PACKED | QC | Wrong-lot pack refused; full set → PACKED | E2E step 2, DS, U | WORKING | Scanner hardware NOT TESTED (USB scanners act as keyboards) |
| QC | Unprinted / voided / recalled / unknown / other manufacturer's code | QC | NOT_PRINTED with operator guidance; BLOCKED_CODE; UNKNOWN_CODE; other plant's code looks unknown | U `printConfirmation`, `disclosure`, DS | WORKING | — |
| QC | Quarantine (missing/wrong pack) → Void, or Reprint with reason → QC again | QC/Operator | Blocked from dispatch while quarantined | U `quarantine`, DS | WORKING | — |
| Chain | Dispatch with invoice; receive; wrong receiver refused + alert | Plant/SS/DB | Status and location follow each hand-over | E2E steps 3–5, API Traceability 16/16, DS | WORKING | — |
| Chain | SS → DB → Retailer and SS → Retailer directly | SS/DB/RT | Only assigned partners are destinations | E2E step 5, API, DS | WORKING | — |
| Chain | Retailer opens a case/tray; packs then move singly | Retailer | Only retailers open | E2E, DS | WORKING | Distributors/SS cannot split cases (decision #7) |
| Chain | My stock / My partners | SS/DB/RT/Plant | Own stock and own children only | API Hierarchy, DS isolation check, UI | WORKING | — |
| Chain | Damaged stock | Plant/SS/DB/RT | Leaves stock, HQ alerted | E2E step 10, U `damage` | WORKING | No returns / write-off process |
| Chain | Returns, corrections after the plant, retail sales | — | — | — | NOT IMPLEMENTED | Known gaps (key note 13) |
| HQ | Search code: status, location, parent/children, full timeline | HQ | Every step with person and time | E2E step 6, DS, UI | WORKING | — |
| HQ | Dashboard, Alerts, Batches & recall, Scan audit | HQ | Counts match data; recall blocks the batch everywhere | E2E step 7, API Reporting/Audit, U | WORKING | Dashboard p95 1.6 s at 100k codes on PostgreSQL (DEF-002) |
| Public | QR check page `/t/<code>` | Consumer | Genuine / Recalled; no business data | E2E step 7, API, UI | WORKING | — |
| Security | Sign-in, lockout after 5 failures, HttpOnly SameSite cookie, sign-out | All | — | API Auth 7/7, UI sign-out ×7 | WORKING | No 2FA; no forced password change at first sign-in |
| Security | Role permissions on every API (7 roles × 18 APIs) | All | Matches `permissions.ts` | API 126 requests | WORKING | — |
| Security | Cross-site writes, non-JSON, malformed, > 256 KB bodies | — | Refused | API Security 17/17 | WORKING | — |
| Security | Cross-partner / cross-manufacturer isolation | All | No leakage of stock, status or existence | U `disclosure`, `access`, API, DS | WORKING | Only one manufacturer in the demo; isolation is unit-tested |
| Security | Production always requires sign-in | — | `SIGN_IN=off` ignored in a production build | U `signInMode.test.ts` | WORKING | Dev PC currently runs `SIGN_IN=off` (dev mode only) |
| Security | Session expiry (12 h) | All | Expired sessions refused | Code present (`auth.ts`); no direct test | NOT TESTED | — |
| Security | Rate limiting | — | Per-process limits | Lockout tested; others not load-tested | PARTIALLY WORKING | In-memory, per process: not shared across servers |
| Security | Sessions started while sign-in was off survive switching on | — | — | Open P2 | BUG | AUTH-1, fix awaiting approval; dev PCs only |
| UI | All pages of all 7 roles at 1440/1366/768/390 px | All | Title, no errors, no sideways scroll, no dev controls | UI 873/873 | WORKING | Two Admin pages scrolled sideways on phones; **fixed today** |
| UI | Keyboard focus, drawer focus trap, reduced motion | All | Visible focus; Escape closes drawer | UI (Tab focus ×7), earlier QA | WORKING | No screen-reader audit |
| Storage | JSON file and PostgreSQL behave the same | — | Same results | U both projects | WORKING | JSON store not for production volumes; PostgreSQL proven to 100k only |

## B. Management demo script (30–45 min)

Open **http://127.0.0.1:3400** in Edge or Chrome on the demo PC. Use a separate browser profile (or a private window
per role) so sign-ins do not mix. Passwords: `C:\Users\ADMIN\velza-demo\demo-credentials.json` (see [C](#c-demo-user-credential-register)).
Codes below are those of the current demo data; after a reset they change (find them under Print orders / My stock).

| # | Min | Sign in as | Where | Do | Data | Expected result | What management should notice |
|---|---|---|---|---|---|---|---|
| 1 | 3 | — | Slides or this page | System overview: Manufacturer → SS → Distributor → Retailer; every case, tray and pack has its own code | — | — | One code per unit, end to end |
| 2 | 4 | **AD0001** (Admin) | Partners | Show the 7 DEMO partners; filter *Show* by the SS, then by DEMO-Distributor Mumbai | — | SS0001 lists DB0001, DB0002, RT0003; DB0001 lists RT0001 | Hierarchy, including the direct SS → Retailer link |
| 3 | 2 | AD0001 | Devices; Batch code pools | Show the two plant PCs and their pre-issued batch codes | DEMO Plant PC-1 / PC-2 | Pools of reserved codes per PC | Codes are pre-issued, random and never reused |
| 4 | 2 | **MF0001-OP** (Operator) | sidebar shows Operator menu only | Point out the role-specific menu | — | 7 menu items | Each role sees only its portal |
| 5 | 4 | MF0001-OP | New print order | Walk the questions: 1 batch, Original, today's dates, 1 case, 0 trays → summary → **Create & print** | Flavour Original | 5 stickers listed with every field | Codes generated, not yet printed |
| 6 | 3 | MF0001-OP | Open print view | Show the real-size lot sticker (barcode + QR) and pack stickers; status **PRINTING PENDING** | — | — | Barcodes/QR generated by the system |
| 7 | 3 | MF0001-OP | Print orders → **Finish printing** on the Green Apple order (`GWBTHM`) | Press **Print** (cancel the dialog) → still PENDING. Press **Mark as printed** | Order of 3 lots | "3 lot(s) marked PRINTED at …"; status PRINTED with time | Printing is confirmed explicitly; a cancelled dialog records nothing |
| 8 | 4 | **MF0001-QC** (QC) | Verify | Scan `91GWBTHMGA00001`, then its packs `…61`–`…64` (type each + Enter), **Confirm** | — | "verified → PACKED" | QC checks every pack sticker against its case |
| 9 | 2 | MF0001-QC | Verify | Scan `91GWBTHMGA00002`, scan `91GWBTHMGA0000161` (a pack of another case) | — | Refused: does not belong | Mistakes are caught on the spot |
| 10 | 2 | MF0001-QC | Verify | For `91GWBTHMGA00002` scan only 3 packs, **Confirm** | — | QUARANTINED, missing pack named | Quarantined stock cannot move (also show `91BMMU03OR00004`) |
| 11 | 3 | MF0001-OP → **SS0001** | Dispatch (Operator): SS0001, invoice `DEMO-INV-010`, scan `91GWBTHMGA00001`, Confirm. Then SS0001 → Receive, scan it | — | AT_SS | Every hand-over is scanned out and in, with invoice |
| 12 | 3 | **DB0002** → SS0001 | DB0002 → Receive `91BMMU03OR00006` (tray in transit to it). SS0001 → Dispatch `91GWBTHMGA00001` to DB0001 | — | Tray AT_DB; case IN_TRANSIT | Stock in transit is visible |
| 13 | 3 | **RT0001** | Receive; Open lot; My stock | Show `91BMMU03OR00001` already opened, its packs in stock | — | Packs listed singly | Tracking reaches the shelf |
| 14 | 4 | **HQ0001** (HQ) | Search code | Search `91BMMU03OR00001`, then pack `91BMMU03OR0000162` | — | Timeline: generated, printed, verified, dispatched/received ×3, opened — each with person and time | Full traceability from one scan |
| 15 | 3 | HQ0001 | Dashboard; Alerts; Batches & recall; Scan audit | Show counts, the WRONG_RECEIVER alert, batch report, failed scans kept | — | — | Audit history is append-only |
| 16 | 3 | DB0001; any | Try `/hq` as DB0001 (refused); open `http://127.0.0.1:3400/t/91BMMU03OR00003` signed out | — | "Not part of your portal"; public page says Genuine, shows no business data | Role security and consumer check |
| 17 | 2 | — | — | Summary: what is live, what is next (section E) | — | — | Honest status |

Optional (destructive to the demo data, do it last): HQ → Batches & recall → recall `GWBTHM`; scan any of its codes
anywhere → refused, public page says Recalled. Reset the demo afterwards (section F).

## C. Demo user credential register

Demo-only sign-ins. **Passwords are not in this document or in Git**: they are in
`C:\Users\ADMIN\velza-demo\demo-credentials.json` (created with random values by `start-demo.mjs`; local file, outside
the repository). `adminPassword` is for AD0001, `hqPassword` for HQ0001, `partnerPassword` for every partner sign-in.

| Sign-in ID | Role | Partner / portal |
|---|---|---|
| AD0001 | Velza Admin | Admin portal |
| HQ0001 | Velza HQ (trace owner) | HQ portal |
| MF0001-OP | Manufacturer Operator | DEMO-Manufacturer Velza Beverages Plant |
| MF0001-QC | Supervisor / QC | DEMO-Manufacturer Velza Beverages Plant |
| SS0001 | Super Stockist | DEMO-SuperStockist Maharashtra |
| DB0001 | Distributor | DEMO-Distributor Mumbai (under SS0001) |
| DB0002 | Distributor | DEMO-Distributor Nashik (under SS0001) |
| RT0001 | Retailer | DEMO-Retailer Andheri Mart (under DB0001) |
| RT0002 | Retailer | DEMO-Retailer Nashik Fresh (under DB0002) |
| RT0003 | Retailer | DEMO-Retailer Pune Direct (directly under SS0001) |

These IDs exist only in the demo data file. They are unrelated to the sign-ins in `data/db.json`.

## D. System architecture summary

**Implemented**

| Layer | What it is |
|---|---|
| Frontend | Next.js 16 App Router, React 19, TypeScript, Tailwind 4; Velza Global brand, light/dark themes; one portal per role with a left sidebar; scan input works with USB/Bluetooth scanners (keyboard) and the camera |
| API | 37 route handlers under `src/app/api/*`; JSON in/out with zod validation; readable error messages (no internal names) |
| Services | `src/lib/services/*`: print orders and continuation, verify, movement (dispatch/receive/open), operator (reprint/void/sync), trace (lookup, dashboard, alerts, recall), admin, auth. Every write runs in one store transaction |
| Business rules | `src/lib/core/*`: pure functions for codes, status rules, permissions, print plan, alerts — unit-tested |
| Storage | `Store` interface with two implementations: JSON file (development/demo) and PostgreSQL (hand-written SQL, schema v2, `db/schema.sql`); embedded PostgreSQL (PGlite) for tests. Both pass the same tests |
| Authentication | Sign-in ID + password (scrypt), `velza_session` cookie (HttpOnly, SameSite=Lax, 12 h), lockout after 5 failures; production builds always require sign-in |
| Authorization | `src/lib/core/permissions.ts` maps 7 roles to actions; enforced in every service; pages show "not part of your portal"; partner scoping by hierarchy |
| Code generation | Batch code: 6 random characters, pre-issued per PC from a pool. Lot (case/tray): country(2)+batch(6)+flavour(2)+hex lot number(5) = 15 chars, counter per batch (never reused, up to 99,999). Pack: lot code + pack size + sequence = 17 chars |
| Traceability model | One row per sticker (lot or pack) with status and location; append-only movement history (who, when, from, to, invoice) and scan audit (successes and failures) |
| Deployment (today) | Runs locally (`npm run dev` / `next start`); no hosted environment yet |

**Proposed, not built**: hosted deployment (AWS Mumbai: Lightsail + managed PostgreSQL with standby), backups and
restore drills, shared rate limiter, plant server for real offline, database-side aggregation for the dashboard,
optional Python/FastAPI backend (decision #15), 2FA for Admin/HQ.

## E. Known limitations

| Area | Limitation | Impact |
|---|---|---|
| Hardware | No physical label printer, USB/2D scanner or phone camera was used in testing (camera scanning is tested through the browser's fake camera with a real barcode image; manual device checklist: `docs/MANUAL_QA_GUIDE.md` §8) | Sticker size/quality and scanner behaviour must be checked on the real devices before go-live |
| Scanning (branch `feature/barcode-scanner`, not yet in the demo build) | Live scan checklists, camera controls (Start/Stop, camera choice, torch) and the fast-scanner queue are not in the demo workspace until it is rebuilt from that branch | Rebuild the demo (section F) to show them |
| Printing | Printing is confirmed by the operator (**Mark as printed**); the app cannot detect whether the printer actually printed | Operator SOP must say: confirm only after checking the stickers |
| Plant PCs | Operator screens always use the plant's first registered PC (the API supports choosing a PC; the screen has no picker) | Second PC usable only through the API today |
| Offline | "Offline" is a flag; a real network/server outage stops printing | Needs a plant server for zero downtime (decision #12) |
| Scale | PostgreSQL proven to 100,000 codes; HQ dashboard p95 1.6 s there (target 1 s); 2 crore codes never tested; JSON store unsuitable beyond small volumes | DEF-002 remainder before production |
| Security | AUTH-1 open (dev PCs only); no 2FA; no forced password change; rate limits per process; session expiry not directly tested; no external penetration test | Fix/decide before production |
| Admin | No search/sort/paging on Partners (DEF-004); PIN not checked against state (INFO-1); partner names not unique (INFO-3) | Usability at scale |
| Workflows | No returns, post-plant corrections (relabel, wrong dispatch), retail sales; only retailers open cases | Business decisions #7, #8, #13 |
| Demo | Demo uses the JSON store and one manufacturer; cross-manufacturer isolation is proven by unit tests, not shown live | — |
| Dev PC | Your development app on port 3000 currently runs with `SIGN_IN=off` (dev mode) | Development only; never deploy that way |

## F. Demo startup guide

Workspace `C:\Users\ADMIN\velza-demo`:

```
velza-demo\
  app\                    copy of the CRM (production build in app\.next)
  data\demo.json          the demo data (only file the demo server writes)
  demo-credentials.json   demo passwords (private, never in Git)
  start-demo.mjs          start: production server, sign-in ON, 127.0.0.1:3400
  stop-demo.mjs           stop: only the process listening on 127.0.0.1:3400
  evidence\               test results (demo-setup, demo-ui, qa-run)
  logs\server.log         server log (passwords masked)
```

**Environment** (set by `start-demo.mjs`; no `.env` file, no production secrets): `NODE_ENV=production`,
`STORE=json`, `VELZA_DB_PATH=velza-demo\data\demo.json`, `SIGN_IN=on`, `VELZA_ADMIN_PASSWORD` / `VELZA_HQ_PASSWORD`
from `demo-credentials.json`; `DATABASE_URL` and the demo helper are removed.

**Start**: `cd C:\Users\ADMIN\velza-demo` → `node start-demo.mjs` (keep the window open) → open http://127.0.0.1:3400.

**Health checks**: http://127.0.0.1:3400/login shows the sign-in page; `curl http://127.0.0.1:3400/api/auth/mode`
answers with sign-in required; signing in as AD0001 shows 7 DEMO partners.

**Stop**: `node stop-demo.mjs` (or Ctrl+C in the start window). It refuses port 3000.

**Reset the demo data (demo workspace only, never the project's `data/db.json`)**:

1. `node stop-demo.mjs`
2. Delete `C:\Users\ADMIN\velza-demo\data\demo.json` (keep `demo-credentials.json`)
3. `node start-demo.mjs`, wait for "Ready"
4. In PowerShell, in `C:\Users\ADMIN\velza-demo\app`:

   ```powershell
   $env:DEMO_BASE = "http://127.0.0.1:3400"
   $env:DEMO_DB_PATH = "C:\Users\ADMIN\velza-demo\data\demo.json"
   $env:DEMO_CREDENTIALS = "C:\Users\ADMIN\velza-demo\demo-credentials.json"
   $env:DEMO_EVIDENCE = "C:\Users\ADMIN\velza-demo\evidence\demo-setup-results.json"
   npx tsx tests/qa/demoSetup.ts
   ```

   → expect `31/31 checks passed`. Batch and lot codes are new random ones after a reset, so update the codes in the
   script (section B) from Print orders / My stock.

**Rebuild after code changes**: stop the demo, copy the project's `src` into `velza-demo\app\src`, run
`npx next build` in `velza-demo\app`, start again.

## Evidence

| Run (4 Nov 2026) | Result | File |
|---|---|---|
| Unit, JSON store | 357 passed, 1 skipped (25 files) | `npm test` output |
| Unit, PostgreSQL (PGlite, `--no-file-parallelism`) | 140 passed, 3 skipped (12 files) | — |
| ESLint, TypeScript | 0 errors, 0 warnings / no errors | — |
| Production build | passed (inside the e2e run and the demo build) | — |
| Playwright e2e (port 3100, own data) | 12/12 | — |
| API harness on a throwaway QA instance (port 3410) | 101 PASS, 0 FAIL, 1 NEEDS INVESTIGATION (INFO-1) | `velza-demo\evidence\qa-run.log`, `qa-run-results.json` |
| Demo build-up through the API (port 3400) | 31/31 | `velza-demo\evidence\demo-setup-results.json` |
| Demo browser check, 7 roles × all pages × 4 widths | 873/873 (37 expected sign-in-page 401s counted separately) | `velza-demo\evidence\demo-ui-results.json` |
| Rehearsal of script steps 5–16 through the API, on a throwaway copy of the demo data (port 3420) | 16/16 API steps; the public-page step renders in the browser and is covered by the browser check | `velza-demo\evidence\rehearse-demo-script.mjs` |

Not run: physical printer, barcode scanner or camera tests (no hardware); load tests (last run 28 Oct, see
`docs/SCALABILITY_REPORT.md`); screen-reader audit.
