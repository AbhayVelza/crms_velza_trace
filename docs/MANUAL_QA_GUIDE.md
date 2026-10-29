# Velza Traceability CRM — Manual QA and Team-Lead Demo Guide

A human walkthrough of the QA dataset with **sign-in ON**, role by role, with what you should see at each step.
Automated equivalents: `tests/qa/qaRun.ts` (API) and `tests/qa/qaUi.mjs` (browser); results in
[QA_REPORT.md](QA_REPORT.md).

## 1. What you need

- Node.js (24 per the README; 22 also runs), the repo with `npm install` done.
- The QA data file `data/qa-mh-2026.json` and its passwords file `data/qa-mh-2026-credentials.json` (both git-ignored,
  created by the QA run on the PC where it ran — copy both files together, or create a fresh set with §3).
- Microsoft Edge or Chrome. Optional: a phone on the same Wi-Fi (camera scanning needs HTTPS, not covered here).

Your everyday data (`data/db.json`) is not used or changed by anything in this guide.

## 2. Start the QA server

Stop any `npm run dev` running in this folder first (two `next dev` in one folder conflict). Then:

```powershell
node tests/qa/startQaServer.mjs          # next dev on http://localhost:3300, data/qa-mh-2026.json, sign-in ON
# or, faster pages:
npm run build; node tests/qa/startQaServer.mjs start
```

Open **http://localhost:3300**. You should land on the **Sign in** page (not "Choose who you are"): sign-in is on.

Passwords: open `data/qa-mh-2026-credentials.json`. `adminPassword` is for AD0001, `hqPassword` for HQ0001, and
`partnerPassword` for every QA partner sign-in. Never paste them into chats, tickets or screenshots.

## 3. Fresh dataset on a new PC (only if you don't have the QA files)

```powershell
node tests/qa/startQaServer.mjs start     # creates the credentials file and, on first request, an empty QA store
# in a second window:
$env:QA_BASE="http://localhost:3300"; npx tsx tests/qa/qaRun.ts
```

The run registers the 18 partners through the real API (it skips any that already exist — safe to rerun), runs the
checks, and writes `docs/qa/qa-run-results.json` and `docs/qa/maharashtra-test-data.json`. Expect
`{"PASS":…,"FAIL":1,…}` — the one FAIL is the known defect DEF-001.

## 4. Sign-ins

| Role | Sign-in ID | Partner |
|---|---|---|
| Velza Admin | AD0001 | — |
| Velza HQ | HQ0001 | — |
| Manufacturer Operator | MF0001-OP | QA-MH-2026-MFG-001 Sahyadri Beverages Plant |
| Supervisor/QC | MF0001-QC | same plant |
| Super Stockist | SS0001 / SS0002 | QA-MH-2026-SS-001 Deccan (Pune) / SS-002 Konkan Coast (Panaji, Goa) |
| Distributor | DB0001 … DB0005 | DST-001 Shivajinagar … DST-005 Solapur |
| Retailer | RT0001 … RT0010 | RTL-001 Kothrud Fresh Mart … RTL-010 Pandharpur Fresh |

Full hierarchy: [qa/maharashtra-test-data.md](qa/maharashtra-test-data.md). Use a private/incognito window per role, or
**Sign out** (top right) between roles.

## 5. Role-by-role demo

### A. Velza Admin (AD0001)

| # | Do | Expect |
|---|---|---|
| A1 | Sign in | Sidebar: Partners, Sign-ins & passwords, Devices, Countries & flavours, Batch code pools, Settings |
| A2 | Partners | 18 rows, every name starting `QA-MH-2026-`; IDs MF0001, SS0001–SS0002, DB0001–DB0005, RT0001–RT0010 |
| A3 | Show → "Distributors and retailers of QA-MH-2026-SS-001 …" | DB0001, DB0002, DB0003 only |
| A4 | Show → "Retailers of QA-MH-2026-DST-004 …" | RT0007, RT0008 only |
| A5 | Register a partner: Tier Super Stockist, State Maharashtra | State list greys out Maharashtra and Goa (one Super Stockist per state) |
| A6 | Register a partner: Tier Retailer, any details, phone `+91 00000 202618` | Refused: phone already used by QA-MH-2026-RTL-010 (RT0010) |
| A7 | Open `http://localhost:3300/hq` by typing the URL | "This page is not part of the Velza Admin portal" |
| A8 | Sign out | Back on Sign in |

Don't save changes to the 18 QA partners during a demo; use a throwaway partner and delete it (allowed only while it
has no history).

### B. Velza HQ (HQ0001)

| # | Do | Expect |
|---|---|---|
| B1 | Dashboard | Totals and status counts include the QA case (OPENED) and tray (RECALLED); alerts include WRONG_RECEIVER and UNKNOWN_CODE |
| B2 | Batches & recall | Two QA batches: Original (case) and Green Apple marked RECALLED |
| B3 | Search code: paste the case lot code (from Batches → Report, or the Admin data) | Timeline GENERATED → PRINTED → VERIFIED → DISPATCHED/RECEIVED ×3 → OPENED, each with a person and invoice QA-INV-001/2/3; location Kothrud Fresh Mart |
| B4 | Search the same code + `61` (first pack) | Pack, with its parent case |
| B5 | Search `91ZZZZZZOR00001` | UNKNOWN_CODE |
| B6 | Scan audit | Every scan, including the failed ones |
| B7 | Type `/admin/partners` in the address bar | "not part of the Velza HQ portal" |

### C. Manufacturer Operator (MF0001-OP) and QC (MF0001-QC)

| # | Do | Expect |
|---|---|---|
| C1 | Operator: sidebar | New print order, Print orders, Dispatch, Reprint, Void lot, My stock, Damaged; device bar shows "QA-MH-2026 Plant PC" |
| C2 | Print orders | One QA order, 12 stickers, PRINTED; **Codes** lists all 12 with their fields |
| C3 | Dispatch → Destination | Exactly the two Super Stockists |
| C4 | QC: sidebar | Verify, My stock only |

To demo a full new chain: New print order (1 batch, 1 case) → Print → QC Verify (scan lot, then its 4 packs) → Dispatch
to SS0001 → continue with D and E. Codes can be typed or scanned with a USB scanner.

### D. Super Stockist (SS0001) and Distributor (DB0001)

| # | Do | Expect |
|---|---|---|
| D1 | SS0001 → My partners | DB0001, DB0002, DB0003 only (never SS0002's distributors, never retailers of distributors) |
| D2 | SS0001 → Dispatch → Destination | The same three distributors |
| D3 | SS0002 → My partners | DB0004, DB0005 |
| D4 | DB0001 → My retailers / Dispatch | RT0001 and RT0002 only |
| D5 | DB0001 → Dispatch, scan a code to RT0003 | Not possible: RT0003 is not in the list |
| D6 | Any: open `/admin/partners` by URL | "not part of the … portal" |

### E. Retailer (RT0001)

| # | Do | Expect |
|---|---|---|
| E1 | Sidebar | Receive, Open lot, My stock, Damaged (no Dispatch) |
| E2 | My stock | The opened QA case's packs |
| E3 | Open `/dispatch` by URL | "not part of the Retailer portal" |
| E4 | Phone width (DevTools device mode, 390 px): ☰ | Drawer with the same 4 items; Escape closes it |

### F. Consumer (no sign-in)

| # | Do | Expect |
|---|---|---|
| F1 | `http://localhost:3300/t/<case lot code>` in a private window | "Genuine Velza product", product, flavour, batch, dates; no partner names or invoices |
| F2 | `/t/<tray lot code>` | "Recalled — do not consume" |
| F3 | `/t/91ZZZZZZOR00001` | "Unregistered code" |

## 6. Known results to expect

- **DEF-001:** `http://localhost:3300/api/admin/settings` shows the settings JSON even when signed out (should be refused).
- **DEF-003:** with sign-in on, the browser console shows a 404 for `/api/auth/dev-users` on each page (harmless probe).
- No text search, sorting or pagination on the partner table (DEF-004).
- A Maharashtra partner accepts a Delhi PIN code (INFO-1).

## 7. Capturing evidence

- Screenshot each step's result (Win+Shift+S), naming files `<role>-<step>.png`, e.g. `SS0001-D1.png`.
- For API results, attach `docs/qa/qa-run-results.json` and `docs/qa/qa-ui-results.json` from the latest run.
- Note the date, the commit (`git log -1 --oneline`) and whether sign-in was on.
- Never include the credentials file, passwords or session cookies in evidence.
