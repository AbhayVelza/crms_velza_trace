# Velza Barcode Traceability — Prototype

Web prototype of Velza's code generation and lot traceability system for beverage lots:
the manufacturer prints barcode/QR stickers through a guided wizard, QC verifies the pasted stickers,
and every lot is scanned OUT and IN along **Manufacturer → Super Stockist → Distributor → Supplier → Outlet**,
while Velza HQ sees status, location, history, alerts and recalls.

Everyone signs in with a **sign-in ID and password** set by Velza Admin and sees **only their own portal**.
Partner accounts work only after Velza HQ approves them, and each Super Stockist sees and supplies only
the distributors assigned to it.

## Requirements

- Node.js 24 LTS (npm 11)
- For the browser test: Microsoft Edge (preinstalled on Windows) or set `PW_CHANNEL=chrome`

## Run

```bash
npm install
npm run seed            # reset demo data in data/db.json (base data only)
npm run seed -- --demo  # …or base data + one batch already moving down the chain
npm run dev             # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | Start the app (dev mode, with the demo helper) |
| `npm run seed` | Reset `data/db.json`: country 91, 4 flavours, 10 partners, 13 users (default password), 1 device with 10 batch codes |
| `npm run clear-activity` | Delete all activity (batches, lots, packs, movements, scans, reprints) but keep partners, users (with passwords), devices, codes and settings as they are |
| `npm run migrate-accounts` | Upgrade a data file made before sign-in existed: existing users get their seeded sign-in ID and the default password |
| `npm test` | Unit + service tests (vitest): code rules, movement rules, alerts, store, barcode scan-back, the full demo script at service level |
| `npm run test:e2e` | The demo script below in a real browser (Playwright, builds and serves on port 3100 with its own data file) |
| `npm run typecheck` | TypeScript check |
| `npm run build` / `npm start` | Production build / server (the demo helper is hidden; set `NEXT_PUBLIC_DEMO_HELPER=1` at build time to keep it) |

The app works without `npm run seed`: if `data/db.json` is missing it is created with the base seed.

## Signing in

Open http://localhost:3000 → sign-in page. Seeded accounts all start with the password **`Velza@2026`**
(set `SEED_PASSWORD` before `npm run seed` to use another one). Change it under **Account** after signing in.

| Sign-in ID | Portal | Organisation |
|---|---|---|
| `admin` | Velza Admin | Velza Global India |
| `hq` | Velza HQ: dashboard, search, alerts, recall, account approvals | Velza Global India |
| `operator`, `qc` | Manufacturer Operator, Supervisor/QC | Demo Manufacturer – Pune |
| `ss1`, `ss2` | Super Stockist | SS-1 (North & West Maharashtra → DB-1), SS-2 (East & South Maharashtra → DB-2) |
| `db1`, `db2` | Distributor | DB-1, DB-2 |
| `supplier1`, `supplier2` | Supplier | Supplier-1, Supplier-2 |
| `outlet1` … `outlet3` | Outlet | Outlet-1 … Outlet-3 |

- **Admin → Users & sign-in** creates every account with its sign-in ID and password, resets passwords,
  changes role/partner, disables or deletes accounts. Creating a partner account counts as the Admin's approval.
- **HQ → Account approvals** approves it; until then the account cannot sign in. HQ can also reject or revoke
  (with a reason), which signs the person out at once. Changing a user's role or partner sends the account
  back to HQ. Velza Admin and Velza HQ accounts need no approval.
- **One portal per role**: the menu shows only that role's screens and every API call checks the role, so
  another portal's URL shows "not part of your portal" and its data is refused (403).
- **Super Stockist territories**: Admin → Partners → *Assigned Super Stockist* on each distributor. A Super
  Stockist's dispatch list and **My distributors** page contain only its own distributors; dispatching to any
  other distributor is refused.
- Admin can **delete** partners, users, devices, countries and flavours that have no history; anything already
  in the ledger can only be deactivated (history is permanent).
- Passwords are stored as scrypt hashes and sessions as SHA-256 hashes of an HttpOnly cookie (12 hours).
  5 wrong passwords lock that sign-in ID for 5 minutes.

## Scanning

Every scan screen has a text box that is always focused and submits on **Enter**, so USB/Bluetooth
barcode scanners (which type the code and press Enter) work everywhere. **Use camera** scans Code 128
and QR with the device camera; a QR URL is reduced to its last path segment (the code).
In dev mode a **Demo helper** under each scan box lists click-to-scan codes relevant to that screen.

Phone camera scanning needs HTTPS: on the same Wi-Fi run `npx next dev --experimental-https` and open the
`https://<pc-ip>:3000` address on the phone (or use a tunnel). Set **Admin → Settings → Public base URL**
to the address phones should open when they scan a sticker's QR code.

## Demo script (spec 9.1)

Sign in as the user named in each step (sign-in IDs above; **Sign out** in the header to switch).
Start from a fresh `npm run seed`.

1. **Manufacturer Operator → New print order.** 2 batches → Batch 1 *Original*, Batch 2 *Green Apple* →
   keep the dates → cases: 2 and 0 → trays: 1 and 1. The **Summary** shows batch codes from the pool,
   lots `00001–00003` (cases `00001–00002`, tray `00003`) and `00001`, and `17 + 7 = 24` stickers.
   **Create & print → Open print view**: lot sticker first, then its packs. Choose *Label roll* or
   *A4 sheet* and **Print** — the lots become `PRINTED`.
2. **Supervisor/QC → Verify.** Scan a lot, then its packs (ticks appear). Scan *pack of another lot*
   from the demo helper → red "does not belong". **Confirm → PACKED**. Repeat for all 4 lots.
3. **Manufacturer Operator → Dispatch.** Destination *SS-1*, invoice `INV-001`, scan the two Original
   cases (`…OR00001`, `…OR00002`) → **Confirm dispatch**.
4. **`ss2` → Receive.** Scan `…OR00001` → red `WRONG_RECEIVER` (also on the HQ alerts). Sign in as
   **`ss1`** → receive both cases → `AT_SS`.
5. **SS-1 → Dispatch** case `…OR00001` to *DB-1* (`INV-002`); **DB-1 → Receive**; **DB-1 → Dispatch** to
   *Supplier-1* (`INV-003`); **Supplier-1 → Receive**; **Supplier-1 → Open lot** (scan the case);
   **Supplier-1 → Dispatch** pack `…OR0000162` to *Outlet-1* (`INV-004`); **Outlet-1 → Receive** it.
6. **`hq` → Search code.** The case code shows every step with user, device and invoice;
   pack `…62` is `AT_OUTLET` at Outlet-1, with its parent lot.
7. Scan the *made-up code* on any scan screen → `UNKNOWN_CODE`. **Batches & recall → Report** on the
   Green Apple batch → reason → **Recall**. Its lot shows `RECALLED`; open `/t/<that lot code>`
   (what the QR opens) → "Recalled — do not consume".
8. **Manufacturer Operator:** click **● Online** in the header to go **Offline**. Create a 1-case batch,
   print, verify it as QC. Dispatch it → red `UNSYNCED`; HQ search → `UNKNOWN_CODE`. Click **● Offline** to go
   back Online, press **Sync** → the dispatch now works.
9. **Manufacturer Operator → Reprint.** Pick a code still at the factory (e.g. a pack of the Original
   tray), give a reason → **Log reprint** → print view shows the same code; the reprint log keeps the reason.

`npm run test:e2e` runs exactly these steps in Edge (signing in for each) and decodes all 24 printed
stickers; a first step checks sign-in, portal isolation and the Super Stockist territory.

## How it is built

| Path | What lives there |
|---|---|
| `src/lib/core` | **All business rules**, pure and unit tested: code formats and allocation (`codes.ts`), statuses and movement rules (`rules.ts`), alerts (`alerts.ts`), print-order planning (`printOrder.ts`), sticker content (`stickers.ts`), role permissions, account approval and password rules (`auth.ts`) |
| `src/proxy.ts` | Sends visitors without a session cookie to `/login` (the API does the real checks) |
| `src/lib/store` | `Store` interface (`Store.ts`) + JSON-file implementation (`jsonStore.ts`) + seed data; `index.ts` picks the store from `STORE` (default `json`) |
| `src/lib/services` | Application services: load from the store, call core rules, persist in one transaction, write the movement ledger and scan audit |
| `src/app/api` | Route handlers: zod-validated input → service → JSON |
| `src/app/(screens)` | Role screens (client components that call the API) |
| `src/app/print`, `src/app/t` | Print view; public QR lookup page |
| `src/components` | Shared UI: scan input (scanner/camera/demo helper), stickers, header, tables |

**Codes** — lot `CC BBBBBB FF XXXXX` (15 chars, e.g. `91ABC123OR00001`), pack = lot + pack size +
sequence (17 chars, e.g. `91ABC123OR0000162`). Batch codes are crypto-random, issued to devices in
advance in pools. Lot numbers are uppercase hex `00001–1869F`, one counter per batch shared by cases and
trays, never reused. Nobody types or edits a code; only `src/lib/core/codes.ts` builds them.

**History** — every action appends to the `movements` ledger (never updated); every scan, success or
failure, goes to `scans`. Alerts are computed from these plus items in transit.

### Plugging in a real database

UI and API never touch `data/db.json`. Implement the `Store` interface in
`src/lib/store/Store.ts` (one repository per table with `get/findOne/list/create/createMany/update`,
append-only `movements/scans/reprints`, `nextLotNumber`, settings, and `transaction(fn)` mapped to a DB
transaction), add it to `src/lib/store/index.ts` under a new `STORE` value, and the services, rules and
screens work unchanged. Collections are named after the intended tables; IDs are UUID strings and
timestamps ISO strings.

Decisions made where the spec was silent are listed in [ASSUMPTIONS.md](ASSUMPTIONS.md).
