# Velza Barcode Traceability — Prototype

Web prototype of Velza's code generation and lot traceability system for beverage lots:
the manufacturer prints barcode/QR stickers through a guided wizard, QC verifies the pasted stickers,
and every lot is scanned OUT and IN along **Manufacturer → Super Stockist → Distributor → Retailer**
(some retailers are supplied by their Super Stockist directly: **Manufacturer → Super Stockist → Retailer**),
while Velza HQ sees status, location, history, alerts and recalls.

Everyone **signs in** with the sign-in ID and password Velza Admin gave them, and sees **only their own portal**.
**While the app is being developed, sign-in is switched off** under `npm run dev`: you pick a role and a person
(start page, or the Role / User selects in the header) with no password. See [Sign-in on or off](#sign-in-on-or-off).
Each Super Stockist and Distributor sees and supplies only the partners assigned to it
(SS → its distributors and its direct retailers; DB → its retailers). Data lives in a JSON file until a PostgreSQL database is connected
(one setting, see [Connecting the database](#connecting-the-database)).

## Requirements

- Node.js 24 LTS (npm 11)
- For the browser test: Microsoft Edge (preinstalled on Windows) or set `PW_CHANNEL=chrome`

## Run

```bash
npm install
npm run seed            # clean start; prints the Velza Admin (AD0001) and Velza HQ (HQ0001) passwords
npm run dev             # http://localhost:3000 → pick a role and a person (sign-in is off while developing)
```

| Command | What it does |
|---|---|
| `npm run dev` | Start the app (dev mode, with the demo helper) |
| `npm run seed` | Reset the data to a clean start: country 91, the 4 flavours, default settings, and two sign-ins — Velza Admin `AD0001` and Velza HQ `HQ0001` — with the passwords from `VELZA_ADMIN_PASSWORD` / `VELZA_HQ_PASSWORD` or new random ones, printed once. No partners or devices |
| `npm run clear-activity` | Delete all activity (batches, lots, packs, movements, scans, reprints) but keep partners, sign-ins, devices, used batch codes, ID sequences and settings |
| `npm test` | Unit + service tests (vitest), twice for the business logic: on the JSON file and on PostgreSQL (embedded) |
| `npm run test:e2e` | The demo script below in a real browser (Playwright, builds and serves on port 3100 with its own data and the test sample network) |
| `npm run test:e2e:postgres` | The same browser demo script with the app on PostgreSQL (embedded) |
| `npm run db:migrate` | Create / update the tables in the database (`DATABASE_URL`) and show what is in it |
| `npm run db:import-json` | Copy `data/db.json` into the database (refuses if the database already has partners or codes, unless `--force`) |
| `npm run db:schema` | Write the PostgreSQL schema to `db/schema.sql` |
| `npm run db:convert-chain` | Convert data from the old chain (with Suppliers and Outlets) to the new one: Outlets become Retailers (`RT…`) assigned to their Supplier's Distributor; Suppliers and their sign-ins are removed. Refuses if a Supplier holds stock or has history; writes a backup first. `--dry-run` shows what would change without saving. See [Converting data from the old chain](#converting-data-from-the-old-chain) |
| `npm run typecheck` | TypeScript check |
| `npm run build` / `npm start` | Production build / server (the demo helper is hidden; set `NEXT_PUBLIC_DEMO_HELPER=1` at build time to keep it) |

The app also starts without `npm run seed`: an empty store gets the clean start, and the two passwords are
printed once in the server log.

## Sign-in and IDs

| Who | Sign-in ID | Made by |
|---|---|---|
| Velza Admin | `AD0001`, `AD0002` … | seed; more on *Sign-ins & passwords* |
| Velza HQ | `HQ0001`, `HQ0002` … | seed; more on *Sign-ins & passwords* |
| Manufacturer (plant) | `MF0001-OP` (Operator), `MF0001-QC` (QC) | the registration form |
| Super Stockist | `SS0001` … | the registration form |
| Distributor | `DB0001` … | the registration form |
| Retailer | `RT0001` … | the registration form |

- Every partner gets the **next number of its tier**; numbers are never changed or reused, even after a delete.
- Velza Admin sets the first password and shares it. The person can then change it (**Account**), and that is
  the only thing they can change; everything else is managed by Velza Admin.
- Passwords are stored scrambled (scrypt): nobody can read one back. A forgotten password is replaced by Velza
  Admin with a new one, which also signs the person out everywhere.
- A sign-in is locked for 5 minutes after 5 wrong passwords. Sessions last 12 hours (HttpOnly cookie).
- Unticking **Active** on a sign-in or on its partner stops it at once, even mid-session.

### Sign-in on or off

| Setting | Sign-in |
|---|---|
| `npm run dev` (default) | **Off**: pick who to act as; switch any time in the header. Every active person can be picked, including people entered before sign-in existed |
| `npm run build` + `npm start` (default) | **On**: sign-in ID and password |
| `SIGN_IN=on` / `SIGN_IN=off` in `.env.local` | Forces it either way |

Sign-in being off changes only *who you are*; every portal and permission rule still applies (a Retailer still
can't open Admin pages). Turn it on (`SIGN_IN=on`) before anyone outside the development team uses the app.

## Setting up your network

Sign in (or, while sign-in is off, pick) **Velza Admin** (`AD0001`):

1. **Partners → Register a partner** — the registration form: tier, site name, contact person, place
   (locality), address, city, state, PIN code, phone, email, *Assigned to* (distributor → its Super Stockist;
   retailer → its distributor **or** directly its Super Stockist: pick *Distributor* or *Super Stockist* in
   *Assigned to tier*, then the partner) and the password(s). It creates the partner with its ID and
   its sign-in in one step and shows what to share. **One Super Stockist per state**: states that already have one
   are greyed out. Phone and email can't be used twice.
2. **Partners** table: edit any field inline, reassign, filter (*Distributors and retailers of …* an SS,
   *Retailers of …* a DB, *Not assigned yet*), or untick **Active**. The tier is part of the ID and can't change.
3. **Devices**: add the manufacturer's PC; it gets its batch codes immediately.
4. **Sign-ins & passwords**: set a new password for anyone; add more Velza staff sign-ins.

Then each person signs in and works in their portal:

- **One portal per role**: the menu shows only that role's screens, and every API call checks the role, so
  another portal's URL shows "not part of your portal" and its data is refused (403). Only **Velza HQ** sees
  the HQ dashboard.
- **Assignment chain**: a Super Stockist's dispatch list and **My partners** page contain only its assigned
  distributors and the retailers assigned directly to it (not its distributors' retailers); a Distributor sees
  only its assigned retailers (**My retailers**): a DB with 50 retailers sees exactly those 50. Dispatching to
  anyone else is refused. The manufacturer can supply any Super Stockist. A Retailer receives, opens cases and
  trays, and has **My stock** and **Damaged**; it dispatches to nobody.
- **Generated codes**: after **Create & print**, and from **Print orders → Codes**, every generated code is listed
  with every field saved for it (country, batch, flavour, hex lot number, case/tray, pack size, pack sequence,
  lot, dates, status, location, synced, generated at/by), with the sticker total and how many are synced.
  **Download CSV** exports it.
- **Damaged stock**: the plant, Super Stockists, Distributors and Retailers each have a **Damaged** page.
  Give a reason (or pick one), then scan the damaged case, tray or pack: it becomes `DAMAGED`, leaves My stock,
  can't move any more, is listed in that location's Damaged section, and Velza HQ gets a `DAMAGED` alert (also
  counted per location on the HQ dashboard as cases, trays and single packs). Scanning the lot code reports a whole
  case or tray, sealed or opened (an opened one takes the packs of it still at that location); single packs can be
  reported once a Retailer has opened the lot.
- Admin can **delete** partners, sign-ins, devices, countries and flavours that have no history; anything already
  in the ledger can only be deactivated (history is permanent).

## Scanning

Every scan screen has a text box that is always focused and submits on **Enter**, so USB/Bluetooth
barcode scanners (which type the code and press Enter) work everywhere. **Use camera** scans Code 128
and QR with the device camera; a QR URL is reduced to its last path segment (the code).
In dev mode a **Demo helper** under each scan box lists click-to-scan codes relevant to that screen.

Phone camera scanning needs HTTPS: on the same Wi-Fi run `npx next dev --experimental-https` and open the
`https://<pc-ip>:3000` address on the phone (or use a tunnel). Set **Admin → Settings → Public base URL**
to the address phones should open when they scan a sticker's QR code.

## Demo script (spec 9.1)

These steps use the test sample network (`tests/fixtures/sampleNetwork.ts`: Demo Manufacturer `MF0001`,
SS-1 `SS0001` (Maharashtra), SS-2 `SS0002` (Karnataka), DB-1/DB-2 `DB0001/DB0002`, Retailer-1/2/3
`RT0001–RT0003` (Retailer-1/2 under DB-1, Retailer-3 under DB-2) and Retailer-4 `RT0004`, supplied by SS-1
directly; every sign-in's password is `Sample2026pass`) that `npm run test:e2e` loads.
Sign in as the person named in each step.

1. **`MF0001-OP` → New print order.** 2 batches → Batch 1 *Original*, Batch 2 *Green Apple* →
   keep the dates → cases: 2 and 0 → trays: 1 and 1. The **Summary** shows batch codes from the pool,
   lots `00001–00003` (cases `00001–00002`, tray `00003`) and `00001`, and `17 + 7 = 24` stickers.
   **Create & print** lists the 24 generated codes with all their fields; **Open print view**: lot sticker first,
   then its packs. Choose *Label roll* or *A4 sheet* and **Print** — the lots become `PRINTED`.
2. **`MF0001-QC` → Verify.** Scan a lot, then its packs (ticks appear). Scan *pack of another lot*
   from the demo helper → red "does not belong". **Confirm → PACKED**. Repeat for all 4 lots.
3. **`MF0001-OP` → Dispatch.** Destination *SS-1*, invoice `INV-001`, scan the two Original
   cases (`…OR00001`, `…OR00002`) → **Confirm dispatch**.
4. **`SS0002` → Receive.** Scan `…OR00001` → red `WRONG_RECEIVER` (also on the HQ alerts). Sign in as
   **`SS0001`** → receive both cases → `AT_SS`.
5. **SS0001 → Dispatch** (its destinations: *DB-1* and its direct retailer *Retailer-4*) case `…OR00001` to
   *DB-1* (`INV-002`); **DB0001 → Receive**; **DB0001 → Dispatch** to
   *Retailer-1* (`INV-003`); **RT0001 → Receive** → `AT_RETAILER`; **RT0001 → Open lot** (scan the case): its packs
   now count as loose packs in RT0001's stock. Then **SS0001 → Dispatch** case `…OR00002` straight to its direct
   retailer *Retailer-4* (`INV-004`); **RT0004 → Receive** → `AT_RETAILER`.
6. **`HQ0001` → Search code.** The case code shows every step with user, device and invoice;
   pack `…OR0000162` is `AT_RETAILER` at Retailer-1, with its parent lot.
7. Scan the *made-up code* on any scan screen → `UNKNOWN_CODE`. **Batches & recall → Report** on the
   Green Apple batch → reason → **Recall**. Its lot shows `RECALLED`; open `/t/<that lot code>`
   (what the QR opens) → "Recalled — do not consume".
8. **`MF0001-OP`:** click **● Online** in the header to go **Offline**. Create a 1-case batch,
   print, verify it as QC. Dispatch it → red `UNSYNCED`; HQ search → `UNKNOWN_CODE`. Click **● Offline** to go
   back Online, press **Sync** → the dispatch now works.
9. **`MF0001-OP` → Reprint.** Pick a code still at the factory (e.g. a pack of the Original
   tray), give a reason → **Log reprint** → print view shows the same code; the reprint log keeps the reason.

`npm run test:e2e` runs exactly these steps in Edge and decodes all 24 printed stickers; a first step checks
portal isolation and the assignments, a step 10 reports a damaged case, and a step 11 registers a distributor
through the form, signs in as it (`DB0003`) and changes its password.

## How it is built

| Path | What lives there |
|---|---|
| `src/lib/core` | **All business rules**, pure and unit tested: code formats and allocation (`codes.ts`), statuses and movement rules (`rules.ts`), alerts (`alerts.ts`), print-order planning (`printOrder.ts`), sticker content (`stickers.ts`), partner and sign-in IDs, password rules, states (`ids.ts`), role permissions |
| `src/proxy.ts` | Sends visitors without a session cookie to `/login` (the API does the real checks) |
| `src/lib/store` | `Store` interface (`Store.ts`), JSON-file store (`jsonStore.ts`), PostgreSQL store (`sql/`), seed data; `index.ts` picks the store |
| `src/lib/services` | Application services: load from the store, call core rules, persist in one transaction, write the movement ledger and scan audit; sign-in (`auth.ts`), registration (`admin.ts`) |
| `src/app/api` | Route handlers: zod-validated input → service → JSON |
| `src/app/(screens)`, `src/app/login` | Role screens and the sign-in page (client components that call the API) |
| `src/app/print`, `src/app/t` | Print view; public QR lookup page |
| `src/components` | Shared UI: scan input (scanner/camera/demo helper), stickers, generated-codes table, header, tables |

**Codes** — lot `CC BBBBBB FF XXXXX` (15 chars, e.g. `91ABC123OR00001`), pack = lot + pack size +
sequence (17 chars, e.g. `91ABC123OR0000162`). Batch codes are crypto-random, issued to devices in
advance in pools. Lot numbers are uppercase hex `00001–1869F`, one counter per batch shared by cases and
trays, never reused. Nobody types or edits a code; only `src/lib/core/codes.ts` builds them.

**History** — every action appends to the movement ledger (never updated); every scan, success or
failure, goes to the scan audit. Alerts are computed from these plus items in transit.

## Connecting the database

The app runs on PostgreSQL as soon as it has a connection string:

1. Create an empty PostgreSQL database (any provider: Supabase, Neon, AWS RDS, or your own server).
2. Copy `.env.example` to `.env.local` and set
   `DATABASE_URL=postgres://user:password@host:5432/velza?sslmode=require`
   (optionally `VELZA_ADMIN_PASSWORD` / `VELZA_HQ_PASSWORD`).
3. `npm run db:migrate` — creates the tables and the two staff sign-ins (passwords printed once).
   The app does the same on its first start, so this step only shows that the connection works.
4. Optional: `npm run db:import-json` to bring over what is in `data/db.json` (convert it first if it still has
   Suppliers or Outlets, see [Converting data from the old chain](#converting-data-from-the-old-chain)).
5. `npm run dev` / `npm start`. Nothing else changes: screens, rules and APIs are the same.

**Tables** (full SQL with every check in [db/schema.sql](db/schema.sql)):

| Table | One row per | Key |
|---|---|---|
| `partners` | site from the registration form | `partner_id` (`DB0001`); one Super Stockist per state; ID prefix must match the tier |
| `users` | sign-in | `login_id` (`DB0001`, `MF0001-OP`, `AD0001`) → `partner_id` |
| `codes` | sticker: each case/tray (`LOT`) and each pack (`PACK`) with `country_code`, `batch_code`, `flavour`, `hex_code`, `lot_type`, `pack_size`, `pack_sequence`, `lot_code`, dates, status, location, synced | `code`; the code must equal its parts |
| `code_history` | movement, scan or reprint, with the full code as scanned | `history_id`; append-only (a trigger refuses changes) |
| `batches`, `print_orders`, `batch_code_pool`, `devices`, `countries`, `flavours`, `sessions`, `id_counters`, `settings` | supporting data the screens need | |

Every write runs in a serializable transaction (retried automatically on a conflict), so two people scanning the
same case at the same moment can't both succeed. To try the database code without a server, set `STORE=pglite`
(and `PGLITE_DIR=data/pg` to keep the data): an embedded PostgreSQL that runs inside the app — `npm test` and
`npm run test:e2e:postgres` use it.

## Converting data from the old chain

Data entered before the chain changed (Manufacturer → SS → DB → Supplier → Outlet) is converted once with

```bash
npm run db:convert-chain -- --dry-run   # show what would change, save nothing
npm run db:convert-chain                # convert (a backup is written first)
```

It converts the data the app uses (`data/db.json`, or the database when `DATABASE_URL` is set):

- every Outlet becomes a Retailer with a new `RT…` ID, assigned to the Distributor its Supplier was assigned to
  (Admin → Partners can then reassign any of them, e.g. straight to a Super Stockist);
- every Supplier and its sign-ins are removed;
- it refuses, changing nothing, if a Supplier holds stock or has history, because history is permanent.

The PostgreSQL schema is now v2 (tiers `MANUFACTURER`, `SS`, `DB`, `RETAILER`; ID prefixes `MF`, `SS`, `DB`, `RT`;
status `AT_RETAILER`). A v1 database is upgraded in place once its data has been converted.

Decisions made where the spec was silent are listed in [ASSUMPTIONS.md](ASSUMPTIONS.md).

Security layers built into the app, and what to set up around it on a server, are in [SECURITY.md](SECURITY.md).
