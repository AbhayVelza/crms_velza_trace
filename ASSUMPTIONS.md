# Assumptions and decisions

Choices made where the spec was silent or ambiguous. Simplest reasonable option each time.

## Setup

- Node.js 24 LTS and Git were installed with winget (machine had neither).
- Next.js 16.4 (current stable) is used with its defaults (`cacheComponents`, `partialPrefetching`).
  Screens are client components that fetch from the API routes, so no page depends on
  server-side dynamic rendering rules.
- `@types/node` pinned to v24 to match the runtime (vitest 5 requires ≥ 22).
- No Google Fonts: the system font stack is used so the app runs without internet.

## Codes and rules (phase 2)

- Lots start in an extra status **GENERATED** (codes allocated, stickers not printed yet). The print
  view calls `window.print()` and then marks the order's lots **PRINTED** (spec: "after printing the
  lot status is PRINTED"). A "Mark as printed" button is also shown in case the print dialog is
  cancelled but stickers were printed.
- `parseCode` validates country and flavour against the configured lists (defaults `91` and
  `OR/GA/NS/MN`); admins can add more. Codes of existing countries/flavours cannot be edited,
  because they are printed inside stickers.
- A malformed scan (wrong length, bad segment) is reported as **UNKNOWN_CODE** (it was "never
  generated"), with the parse error in the message.
- Scanner input is only trimmed; for QR URLs the last path segment is used. Codes are never
  upper-cased or otherwise edited.
- Receive: in transit to me → OK; already at my location → **DUPLICATE_RECEIPT**; recalled /
  quarantined / void → **BLOCKED_CODE**; anything else → **WRONG_RECEIVER** (as the spec says
  "otherwise reject and raise WRONG_RECEIVER").
- A pack code scanned while its lot is still sealed is rejected (LOT_SEALED: "scan the lot code").
  An OPENED lot no longer moves; its packs do (LOT_OPENED).
- Packs mirror their lot's status/location until the lot is OPENED.
- Verification: the API's `confirm` quarantines on failure (spec). The UI keeps Confirm disabled until
  every pack is ticked, so a misclick can't quarantine a good lot; wrong-lot and duplicate scans are
  shown red and not added.
- Void is allowed for GENERATED, PRINTED or QUARANTINED lots ("unpasted or misprinted").
- Reprint is allowed while the item is still at the manufacturer (GENERATED, PRINTED, PACKED,
  QUARANTINED). It never creates a code.
- A QUARANTINED lot has two ways out: **Void** (it becomes VOID for good: no reprint, no QC), or **reprint**
  its lot sticker or one of its pack stickers with a reason. A reprint takes the whole lot (and its packs) back
  to PRINTED, clears the quarantine reason (it stays in the history), and QC must verify the lot again: pass →
  PACKED and it moves normally; fail → QUARANTINED again. Until QC passes it, it can't be dispatched.
- Recall marks every lot and pack of the batch RECALLED except VOID ones; the previous status is kept
  in `statusBeforeRecall` so the report can show the last location (incl. "in transit A → B").
- Alerts are computed (not stored) from the scan audit log + current in-transit items. NOT_RECEIVED
  is raised for lots, and for packs of opened lots (packs inside a sealed lot travel with it).
  Public QR lookups of unknown codes also raise UNKNOWN_CODE (possible counterfeit), and public scans of
  recalled codes raise BLOCKED_CODE.

## Store, API (phase 3)

- The `Store` interface exposes one repository per table (`get/findOne/list/create/createMany/update`),
  append-only repos for `movements`, `scans`, `reprints`, plus `appendMovement`, `appendScan`,
  `nextLotNumber`, settings, and `transaction(fn)`. The JSON store runs each transaction on a draft copy
  and writes the file once (temp + rename), so multi-row actions are all-or-nothing, like a DB transaction.
- If `data/db.json` is missing, the store creates the base seed automatically on first use.
- `data/db.json` is git-ignored (`npm run seed` recreates it). `VELZA_DB_PATH` overrides the file
  path (used by tests).
- Every API call resolves the signed-in user from the session cookie and the services check the role against
  `src/lib/core/permissions.ts` (see "Sign-in, registration and the database" below).
- A service layer (`src/lib/services`) sits between routes and the store: it loads data, calls the pure
  rules in `src/lib/core`, and persists. Routes only parse the request and call a service.
- Dispatch is two calls: `check` validates each scan as it is added to the list (and logs it), `confirm`
  re-validates the whole list and dispatches all or nothing.
- Extra routes beyond the spec list: `/api/bootstrap` (reference data for the signed-in user),
  `/api/stickers`, `/api/devices`, `/api/stock`, `/api/scans`, `/api/demo-codes` (dev helper).
- Unsynced lots are visible only to users of the manufacturer that owns them; HQ and the public see
  UNKNOWN_CODE / "Unregistered code" until sync.
- `--demo` seed: one Mango batch (3 cases + 1 tray), printed and verified; case 1 at SS-1, case 2 in
  transit SS-1 → DB-1, case 3 in transit Manufacturer → SS-1, tray packed at the manufacturer.

## UI shell and admin (phase 4)

- ~~Role switcher + user picker in the header~~ — replaced by sign-in; the header shows the signed-in
  user, their portal, Account and Sign out.
- Next 16 dev "instant navigation" validation is limited to segments that opt in
  (`experimental.instantInsights.validationLevel = "manual-warning"`), because every screen loads its
  data from the API after mount by design.
- Admin tables edit in place (text saves on blur, selects/checkboxes save on change). Partner tier and
  user role are set at creation; countries/flavours can be renamed or deactivated but their code can't
  change. Users of partner roles must point at a partner of the matching tier.
- The manufacturer device's Online/Offline toggle, unsynced count and Sync button are in the header
  for the Manufacturer Operator (always visible while working).
- Admin can also toggle a device offline from Admin → Devices. Issuing codes to an offline device is
  refused (refill is blocked offline).

## Print wizard and stickers (phase 5)

- Wizard: each question is one step; "for each batch" questions show one row per batch on that step.
  Dates default to today (manufacture) and today + 12 months (expiry); operators can change them.
  Basic checks (≥ 1 batch, flavour chosen) block Next; all other validation (0 cases + 0 trays,
  empty/short pool, bad dates) is shown on the Summary step, computed by `lib/core/printOrder.ts`.
- The Summary previews the batch codes that will be taken from the device's pool (oldest reserved
  first). Codes are consumed only when "Create & print" is pressed.
- Sticker geometry is computed in `src/lib/stickerLayout.ts` (unit tested): X-dimension is chosen to fit
  between 0.25 and 0.5 mm, bar height 12–20 mm, 2.5 mm quiet zone each side of the barcode. The QR symbol
  is 20–28 mm with a 3 mm white quiet zone around it (needed for reliable phone scanning). A warning is
  shown in the print view if a configured sticker size is too small for the spec.
- Label roll mode uses CSS named pages (`@page lot` / `@page pack`) so lot and pack stickers each get
  their own page size; verified by printing to PDF: 24 pages = 4 × 100×50 mm + 20 × 75×25 mm.
  A4 mode is a wrapped grid with dashed cut guides.
- Scan-back check: unit test renders Code 128 + QR with bwip-js and decodes with ZXing; the browser check
  screenshots every sticker on the print view and decodes it (24/24 barcodes and QR codes decoded).
- `devIndicators: false` causes an endless reload loop in Next 16.4.3 dev on this machine, so the default
  dev indicator is kept (tests hide it with CSS).

## Offline simulation (phase 9)

- Online/Offline is a per-device flag toggled from the operator's header (or Admin → Devices).
- While offline: the wizard, printing and verification work; new batches, lots and print orders are saved
  with `synced=false`; batch codes come only from the device's RESERVED pool; pool refill (manual or
  automatic) is refused.
- Sync needs the device to be Online (the Sync button is disabled while Offline): switch Online, then
  press Sync. Sync marks the device's batches, lots and print orders `synced=true`, logs one SYNC
  movement, and then tops up the pool if it is below the refill level.
- Going back Online does not sync automatically, so the demo can show "online but unsynced → still
  blocked" if needed.
- Verification and other movements done offline are written to the ledger immediately (this prototype
  has a single server); only the visibility of unsynced lots is simulated.

## Polish (phase 10)

- Scan screens are usable at phone width (390 px): the scan box takes the full width, buttons wrap,
  wide tables scroll inside their card.
- API errors come back as `{ error: { code, message, details } }` and are shown as-is in the UI
  (e.g. `WRONG_RECEIVER: 91… is not in transit to SS-2 …`). Dispatch confirmation lists every rejected code.
- The Playwright demo test (`npm run test:e2e`) builds the app and serves it on port 3100 with
  `VELZA_DB_PATH=data/e2e-db.json`, so it doesn't touch the dev database. It uses the installed Microsoft
  Edge (`channel: msedge`) so no browser download is needed; override with `PW_CHANNEL`.
- The demo helper is shown in dev mode only (or with `NEXT_PUBLIC_DEMO_HELPER=1`).

## Portals, territories, clean data (after phase 10)

- ~~No sign-in for now~~ — sign-in is back with the agreed design; see "Sign-in, registration and the database".
  The earlier Admin + HQ approval step is not part of it: Velza Admin registers partners and has every right.
- **One portal per role**: menus show only the role's screens and every service checks the role, so another
  portal's URL shows "not part of the … portal" and its API calls are refused (403). The Admin portal no
  longer includes the HQ dashboard or search; only Velza HQ (role `TRACE_OWNER`, labelled "Velza HQ") does.
- **Assignment chain SS → DB → Retailer, or SS → Retailer**: each distributor has one Super Stockist, and each
  retailer one Distributor or (for a few) one Super Stockist directly (`partner.parentId`, "Assigned to" in
  Admin → Partners). A Super Stockist sees in its dispatch list and on its **My partners** page exactly its
  assigned, active distributors and direct retailers (not its distributors' retailers); a Distributor sees its
  assigned, active retailers on **My retailers** (assign 50 → it sees those 50). Dispatching to anyone else is
  refused (`ASSIGNED_TO` / `DESTINATION_TYPES` / `isAssignedDestination` in `core/rules.ts`). Super Stockists
  are not assigned to a manufacturer, so the manufacturer can supply any SS. A partner with no assignment
  receives from nobody until the Admin assigns it. (The free-text **Territory** label was replaced by the
  partner's state and address.)
- Admin → Partners has a **Show** filter (a tier, the partners assigned to one SS or DB, partners not assigned
  yet) and a count on each SS and DB row, so long lists stay manageable.
- **Clean data, no demo names**: `npm run seed` (and a missing `data/db.json`) gives country 91, the four
  flavour codes, default settings and two sign-ins, Velza Admin `AD0001` and Velza HQ `HQ0001`. No partners, people, devices or
  batch codes; a device gets its batch codes when the Admin adds it. The country and flavour codes are kept
  because every code depends on them; the Admin can rename, add or deactivate them. The `--demo` seed option
  was removed.
- The automated tests still need a network to run the 9.1 demo script, so the old sample partners and people
  (Demo Manufacturer, SS-1/SS-2, Kiran, …) live in `tests/fixtures/sampleNetwork.ts` and are used only by
  tests (`npm run test:e2e` loads them into its own `data/e2e-db.json`). They have the new IDs (`MF0001`,
  `SS0001` …) and one test password; SS-2 moved to Karnataka because there is one Super Stockist per state.
- **Deletes**: Admin can delete partners (with their own sign-ins), sign-ins, devices, countries and flavours only when nothing in the
  history refers to them; otherwise the message says what uses it and to untick Active instead. A deleted
  device's unused batch codes are marked RETURNED and never reissued. The Admin can't delete or disable their own
  sign-in, and at least one active Admin always remains.
- The dev-only **Demo helper** (click-to-scan codes under each scan box) stays as a checking aid; it shows only
  codes that exist in the data, plus one made-up code to test UNKNOWN_CODE. It is hidden in production builds.

## Security layers

- Layers inside the app: security headers and a Content Security Policy (`next.config.ts`), a cross-site write
  block, JSON-only bodies of at most 256 KB, per-client and global rate limits, the demo
  codes endpoint disabled in production, and `[security]` log lines for every blocked request. Network layers
  (HTTPS, firewall, WAF, VPN/access gate, database, backups) are a deployment checklist in `SECURITY.md`.
- The CSP allows inline scripts (`'unsafe-inline'`) because Next inlines its bootstrap scripts; nonces would
  force every page to render per request. Listed as a next step.
- Next.js passes the client's `X-Forwarded-For` through unchanged, so a client can fake it. Per-client limits
  are therefore only reliable behind a proxy that sets a header named in `CLIENT_IP_HEADER`; a global limit
  for all clients together is the backstop. Limits are generous because a whole shop often shares one IP.
- Rate-limit counters are in memory (per server process, reset on restart); fine for one server.
- HSTS and upgrade-insecure-requests are only sent with `HTTPS_ONLY=1`, so the app still works over plain HTTP
  on a local network and in tests.
- ~~Without sign-in, anyone who can reach the app can act as any user~~ — sign-in is back (next section).

## Damaged stock

- Every partner that holds stock can report damage: Manufacturer Operator (packed stock not yet dispatched),
  Super Stockist, Distributor, Retailer (permission `damage`). QC, Admin and HQ don't hold stock.
- A reason is required (free text, with quick picks). The unit becomes `DAMAGED`, a `DAMAGED` movement is
  written to the ledger with the reason, and the scan is logged with context `DAMAGE`.
- A case or tray is reported **as a whole by its lot code, opened or not**:
  - sealed: the lot and all its packs become `DAMAGED`;
  - opened (at a Retailer): the packs of it still in stock at that location become `DAMAGED` and the
    lot stays `OPENED`, because packs already sent on keep moving. It counts as one damaged case/tray there.
    A location that only received loose packs of a case opened upstream reports those packs one by one.
- A pack inside a sealed lot can't be reported alone (packs only move separately after opening, and only
  Retailers open lots), so a Super Stockist or Distributor with one damaged pack reports the whole
  case. After a lot is opened, single packs can also be reported and the other packs stay in stock.
- Counts are shown as **cases, trays and single packs**: on each location's Damaged page and in the Damaged
  column of the HQ dashboard's Stock by location.
- Only stock **at your location** can be reported: an item in transit to you must be received first (the
  message says so); unpacked lots at the plant use Void or Reprint instead.
- `DAMAGED` is final in this prototype: the unit leaves My stock, can't be dispatched, the public QR page says
  "Not for sale — do not consume", and there is no undo or write-off/return flow yet (see the Working Model's key
  notes). A later recall still marks it `RECALLED`, keeping `DAMAGED` as its status before recall.
- HQ is informed through a computed `DAMAGED` alert per report (Alerts and dashboard), a Damaged column in
  Stock by location, and the item's timeline. Damage on unsynced plant lots shows at HQ after sync.
- The browser test's sticker check now captures QR codes at device resolution: at 1× a QR has about 3 pixels
  per module and some random codes failed to decode (a test-resolution issue, not a sticker issue).

## Stock counts (cases and trays, opened or not)

- My stock and the HQ dashboard's Stock by location count **cases and trays whether opened or not**. An opened
  case or tray counts at the location that opened it while any of its packs is still in stock there (shown as
  "N opened"); once all its packs have moved on or been reported damaged, it no longer counts.
- Loose packs are the packs of opened cases and trays in stock at that location, so a retailer that opened 3 cases
  and 2 trays shows 3 cases, 2 trays and 24 loose packs: the same stock seen two ways, not added together.
- A location that received only loose packs of a case opened upstream counts those packs, not a case.

## Sign-in, registration and the database

- **IDs**: each partner gets the next number of its tier's sequence — `MF`, `SS`, `DB`, `RT` + 4 digits
  (`DB0001`); past 9999 the number simply grows. Numbers come from a counter (`id_counters`), so a deleted
  partner's number is never issued again. The ID is the primary key and never changes; the tier is part of it,
  so a partner's tier can't change (register a new partner instead).
- **Sign-in IDs** = the partner ID; the plant has two, `MF0001-OP` (Operator) and `MF0001-QC` (QC); Velza staff
  have their own sequences `AD0001` (Admin) and `HQ0001` (HQ). Sign-in IDs are typed in any case and stored
  in capitals. A sign-in's role and partner are tied to its ID and can't change; its name and Active flag can.
- **Registration form** (Admin → Partners): tier, site name, contact person, place (locality), address, city,
  state, PIN code, phone, email, assigned-to, password (two at the plant). Required: everything except PIN
  code, email and assigned-to; state is required (an Indian state or union territory) for every tier except the
  manufacturer, which may be abroad. A PIN code given for an Indian state is 6 digits. Phone: digits, spaces,
  +, () and -; the same phone (compared by digits) or email can't be used by two partners. The sign-in's name
  is the contact person.
- **One Super Stockist per state**, checked by the form and by a unique index in the database. A distributor
  may be assigned to the Super Stockist of another state; that isn't blocked.
- **Passwords**: Velza Admin sets the first one (typed, or Generate: 12 letters and digits without look-alike
  characters) and shares it; at least 8 characters with letters and digits. The person can change their own
  password and nothing else. Stored as scrypt hashes; nobody can read one back. A password set by the Admin
  signs the person out everywhere; one changed by the person signs out their other sessions. The person is
  not forced to change the shared password at first sign-in (not asked for; easy to add).
- **Sessions**: 12 hours, HttpOnly SameSite=Lax cookie (Secure over HTTPS), stored as the SHA-256 of the token.
  5 wrong passwords lock a sign-in ID for 5 minutes (in memory, per server). An inactive sign-in or an inactive
  partner can't sign in, and an open session stops working on its next request.
- **First start**: an empty store (JSON file or database) gets the clean start; the two staff passwords come
  from `VELZA_ADMIN_PASSWORD` / `VELZA_HQ_PASSWORD` or are generated and printed once in the server log.
- **Reference data per sign-in**: `/api/bootstrap` gives Velza staff every partner and device, and a partner
  sign-in only its own partner (and, at the plant, its devices). The list of sign-ins is never sent to partners,
  and no API returns a password hash.
- **Database**: PostgreSQL, chosen by setting `DATABASE_URL` (or `STORE=postgres`); without it the JSON file is
  used. The four agreed tables are `partners`, `users`, `codes` (one row per sticker: lot rows and pack rows
  in one table, with country, batch, flavour, hex lot number, lot type, pack size, pack sequence, lot code,
  dates, status, location and synced) and `code_history` (movements, scans and reprints, full code as scanned,
  append-only by trigger). Supporting tables keep what the screens already use: `batches` (next lot number,
  recall), `print_orders`, `batch_code_pool`, `devices`, `countries`, `flavours`, `sessions`, `id_counters`,
  `settings`. Pack rows copy their batch's dates, manufacturer, device, print order and sync flag, so each row
  carries every field; a lot's sync flag is copied to its packs when it changes.
- An opened lot stays one row with status `OPENED`; its packs move as their own rows. `code_history` keeps a
  failed scan of an unknown code too, so its `code` column has no foreign key; `login_id`, `location_id`,
  `from_id` and `to_id` hold IDs as text for the same reason (history is never rewritten).
- Foreign keys are checked at commit (deferrable), so a whole action is checked as one. Transactions are
  serializable and retried up to 5 times on a conflict, matching the JSON store's one-writer-at-a-time behaviour.
- The schema is applied on first use and by `npm run db:migrate` (`CREATE … IF NOT EXISTS`; safe to repeat).
  `SCHEMA_VERSION` is 2 since the chain change (see the last section); a v1 database is upgraded in place once
  its data has been converted. Later schema changes will need numbered migrations.
- Lots and packs are keyed by their printed code (`id` = the code) in both stores.
- **Generated codes view**: after creating a print order (and from Print orders → Codes) every code is listed
  with the same fields as its `codes` row, with totals (stickers, cases, trays, pack stickers, synced) and a CSV
  download. "Synced" means in the central data: an online plant writes straight to it; an offline plant's
  codes are marked unsynced until Sync.
- The test reader (ZXing) misses about 1 in 40 valid lot QR symbols at one pixel size (they decode at other
  sizes, and in another reader, jsQR); the browser test retries a miss at half and a third of the size. The
  stickers were not changed. Lot stickers also carry the Code 128 barcode.
- **Sign-in off while developing** (requested 2026-10-27): `SIGN_IN=off` — the default under `npm run dev` —
  replaces the password with a "pick who you are" list (start page) and Role / User selects in the header. It
  starts a normal session for the chosen person, so all role and partner checks still apply. Anyone active can be
  picked, including people entered before sign-in existed (no partner ID or password). The pick-anyone API
  answers 404 as soon as sign-in is on; a production build has it on unless `SIGN_IN=off` is set. The password
  sign-in stays built and tested (the browser test runs with `SIGN_IN=on`).

## Distribution chain: Retailers, no Suppliers

- **New chain** (requested 2026-10-27): Manufacturer → Super Stockist → Distributor → Retailer, and for a few
  retailers Manufacturer → Super Stockist → Retailer.
  - **Outlet is renamed Retailer** everywhere: tier and role `RETAILER`, IDs `RT0001` …, status `AT_RETAILER`.
  - **The Supplier tier is removed** (tier, role, `SP` IDs, its status and its portal).
  - A Retailer is assigned to a Distributor **or directly to its Super Stockist**, chosen in the registration
    form's "Assigned to" section (*Assigned to tier*: Distributor or Super Stockist, then the partner).
  - The visibility logic is unchanged: a Super Stockist sees and supplies only its distributors and its direct
    retailers (not its distributors' retailers), a Distributor only its retailers (50 assigned → it sees those 50).
  - Only Retailers open cases and trays, as Outlets did; Super Stockists and Distributors ship sealed cases and
    trays, as before. A Retailer doesn't dispatch.
  - Existing data is converted once with `npm run db:convert-chain` (`--dry-run` to preview): Outlets become
    Retailers re-assigned to their Supplier's Distributor; Suppliers and their sign-ins are removed. It refuses
    if a Supplier holds stock or has history, and writes a backup first.
  - PostgreSQL schema v2 (tier, ID prefix and status checks for the new chain); a v1 database is upgraded in place
    once its data has been converted.

