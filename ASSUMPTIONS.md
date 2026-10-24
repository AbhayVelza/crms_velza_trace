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
- There is no login: the browser sends the selected user's id in an `x-user-id` header and the services
  check the role against `src/lib/core/permissions.ts`.
- A service layer (`src/lib/services`) sits between routes and the store: it loads data, calls the pure
  rules in `src/lib/core`, and persists. Routes only parse the request and call a service.
- Dispatch is two calls: `check` validates each scan as it is added to the list (and logs it), `confirm`
  re-validates the whole list and dispatches all or nothing.
- Extra routes beyond the spec list: `/api/bootstrap` (reference data for the role switcher),
  `/api/stickers`, `/api/devices`, `/api/stock`, `/api/scans`, `/api/demo-codes` (dev helper).
- Unsynced lots are visible only to users of the manufacturer that owns them; HQ and the public see
  UNKNOWN_CODE / "Unregistered code" until sync.
- `--demo` seed: one Mango batch (3 cases + 1 tray), printed and verified; case 1 at SS-1, case 2 in
  transit SS-1 → DB-1, case 3 in transit Manufacturer → SS-1, tray packed at the manufacturer.

## UI shell and admin (phase 4)

- Role switcher + user picker live in the header; the choice is saved in `localStorage` and sent as
  `x-user-id`. Opening a screen that belongs to another role shows a "switch role" notice.
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
