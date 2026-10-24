# Velza Barcode Traceability — Prototype

Web prototype of Velza's code generation and lot traceability system for beverage lots:
the manufacturer prints barcode/QR stickers through a guided wizard, QC verifies the pasted stickers,
and every lot is scanned OUT and IN along **Manufacturer → Super Stockist → Distributor → Supplier → Outlet**,
while Velza HQ sees status, location, history, alerts and recalls.

One app with a **role switcher** in the header stands in for all parties (there is no login yet).

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
| `npm run seed` | Reset `data/db.json`: country 91, 4 flavours, 10 partners, 13 users, 1 device with 10 batch codes |
| `npm test` | Unit + service tests (vitest): code rules, movement rules, alerts, store, barcode scan-back, the full demo script at service level |
| `npm run test:e2e` | The demo script below in a real browser (Playwright, builds and serves on port 3100 with its own data file) |
| `npm run typecheck` | TypeScript check |
| `npm run build` / `npm start` | Production build / server (the demo helper is hidden; set `NEXT_PUBLIC_DEMO_HELPER=1` at build time to keep it) |

The app works without `npm run seed`: if `data/db.json` is missing it is created with the base seed.

## Scanning

Every scan screen has a text box that is always focused and submits on **Enter**, so USB/Bluetooth
barcode scanners (which type the code and press Enter) work everywhere. **Use camera** scans Code 128
and QR with the device camera; a QR URL is reduced to its last path segment (the code).
In dev mode a **Demo helper** under each scan box lists click-to-scan codes relevant to that screen.

Phone camera scanning needs HTTPS: on the same Wi-Fi run `npx next dev --experimental-https` and open the
`https://<pc-ip>:3000` address on the phone (or use a tunnel). Set **Admin → Settings → Public base URL**
to the address phones should open when they scan a sticker's QR code.

## Demo script (spec 9.1)

Pick the role and user in the header for each step. Start from a fresh `npm run seed`.

1. **Manufacturer Operator → New print order.** 2 batches → Batch 1 *Original*, Batch 2 *Green Apple* →
   keep the dates → cases: 2 and 0 → trays: 1 and 1. The **Summary** shows batch codes from the pool,
   lots `00001–00003` (cases `00001–00002`, tray `00003`) and `00001`, and `17 + 7 = 24` stickers.
   **Create & print → Open print view**: lot sticker first, then its packs. Choose *Label roll* or
   *A4 sheet* and **Print** — the lots become `PRINTED`.
2. **Supervisor/QC → Verify.** Scan a lot, then its packs (ticks appear). Scan *pack of another lot*
   from the demo helper → red "does not belong". **Confirm → PACKED**. Repeat for all 4 lots.
3. **Manufacturer Operator → Dispatch.** Destination *SS-1*, invoice `INV-001`, scan the two Original
   cases (`…OR00001`, `…OR00002`) → **Confirm dispatch**.
4. **Super Stockist, user Kiran (SS-2) → Receive.** Scan `…OR00001` → red `WRONG_RECEIVER` (also on the
   HQ alerts). Switch to **Kiran (SS-1)** → receive both cases → `AT_SS`.
5. **SS-1 → Dispatch** case `…OR00001` to *DB-1* (`INV-002`); **DB-1 → Receive**; **DB-1 → Dispatch** to
   *Supplier-1* (`INV-003`); **Supplier-1 → Receive**; **Supplier-1 → Open lot** (scan the case);
   **Supplier-1 → Dispatch** pack `…OR0000162` to *Outlet-1* (`INV-004`); **Outlet-1 → Receive** it.
6. **Traceability Owner → Search code.** The case code shows every step with user, device and invoice;
   pack `…62` is `AT_OUTLET` at Outlet-1, with its parent lot.
7. Scan the *made-up code* on any scan screen → `UNKNOWN_CODE`. **Batches & recall → Report** on the
   Green Apple batch → reason → **Recall**. Its lot shows `RECALLED`; open `/t/<that lot code>`
   (what the QR opens) → "Recalled — do not consume".
8. **Manufacturer Operator:** click **● Online** in the header to go **Offline**. Create a 1-case batch,
   print, verify it as QC. Dispatch it → red `UNSYNCED`; HQ search → `UNKNOWN_CODE`. Click **● Offline** to go
   back Online, press **Sync** → the dispatch now works.
9. **Manufacturer Operator → Reprint.** Pick a code still at the factory (e.g. a pack of the Original
   tray), give a reason → **Log reprint** → print view shows the same code; the reprint log keeps the reason.

`npm run test:e2e` runs exactly these steps in Edge and also decodes all 24 printed stickers.

## How it is built

| Path | What lives there |
|---|---|
| `src/lib/core` | **All business rules**, pure and unit tested: code formats and allocation (`codes.ts`), statuses and movement rules (`rules.ts`), alerts (`alerts.ts`), print-order planning (`printOrder.ts`), sticker content (`stickers.ts`), role permissions |
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
