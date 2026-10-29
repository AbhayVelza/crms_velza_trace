# Velza Traceability — Working Model

Oct 27, 2026 · Abhay Velza · living document, updated 28 Oct 2026 (see [Change log](#change-log))

> **How to keep this document current.** This is the single reference for how the CRM works and what has changed.
> Every change to the app (process, data, screens, UI, infrastructure) gets an entry in the
> [Change log](#change-log) at the end, and the section it affects is updated in place. Parts 1 and 2 describe the
> system; Part 3 records the UI redesign; the change log records everything after.

## Contents

- **Part 1 — Working model**
  [Overview](#overview) · [Working model structure](#working-model-structure) · [Tree diagrams](#tree-diagrams) ·
  [Workflow](#workflow) · [Connection establishment](#connection-establishment) ·
  [Roles and responsibilities](#roles-and-responsibilities) · [Database design](#database-design-built-waiting-for-the-database) ·
  [Scale and readiness](#scale-and-readiness-2-crore-stickers) · [Wrong scans and wrong stickers](#wrong-scans-and-wrong-stickers) ·
  [Development and release](#development-and-release)
- **Part 2 — Plans and decisions** · [Python backend plan](#python-backend-plan-proposal-no-code-yet) · [Key notes to discuss](#key-notes-to-discuss)
- **Part 3 — UI redesign (27–28 Oct 2026)** · [Velza Global brand redesign](#part-3--ui-redesign-velza-global-brand-2728-oct-2026)
- **Part 4 — QA, test data and scalability (28 Oct 2026)** · [QA and scalability](#part-4--qa-test-data-and-scalability-28-oct-2026)
- **[Change log](#change-log)**

---

# Part 1 — Working model

## Overview

Velza Traceability gives every case, tray and pack of Velza beverages a unique code and records each hand-over from
the factory to the retailer. Stickers with a barcode and QR code are printed at the plant, checked by QC, and scanned
OUT and IN at every step of the chain: **Manufacturer → Super Stockist → Distributor → Retailer**. A few retailers are
supplied by their Super Stockist directly (**Manufacturer → Super Stockist → Retailer**).

Velza Global India runs the system through two central roles: **Velza Admin** sets up the network, and **Velza HQ**
watches it (status, location, history, alerts, recalls). Each of the 7 roles works in its own portal and sees only its
own part of the chain. Consumers can scan the QR code on a case to check it is genuine and not recalled.

The current build is a working prototype. Sign-in is built but switched off while the app is developed, PostgreSQL
support is built and waits for the database, and data lives in a file until then. The code is on GitHub (see
[Development and release](#development-and-release)). It is not yet ready for 2 crore stickers or for zero downtime at
the plant (see [Scale and readiness](#scale-and-readiness-2-crore-stickers)).

## Working model structure

The model has three parts: a four-tier partner chain, a code on every unit, and a status that moves with each scan.

### Partner tiers and assignment

Every Distributor is assigned to one Super Stockist. Every Retailer is assigned to one Distributor, or to its Super
Stockist directly. A partner sees, and can dispatch to, only the partners assigned to it. The Supplier tier was removed
and Outlet renamed Retailer on 27 Oct 2026.

| Tier | Receives from | Dispatches to | Assigned to | Example |
|---|---|---|---|---|
| Manufacturer (plant) | — | Any Super Stockist | — | vietnam_plant |
| Super Stockist (SS) | Manufacturer | Its assigned distributors and its direct retailers | — | pune_stocks |
| Distributor (DB) | Its Super Stockist | Its assigned retailers | One Super Stockist | fc_road_db, baner_db → pune_stocks |
| Retailer (RT) | Its Distributor, or its Super Stockist | — (sells to consumers) | One Distributor, or one Super Stockist directly | JW Marriot → fc_road_db; Colaba Kirana → pune_stocks |

Example: assign 50 distributors to the Pune SS, and the Pune SS sees exactly those 50 plus the retailers assigned to it
directly. Assign 50 retailers to fc_road_db, and fc_road_db sees exactly those 50. An SS never sees the retailers of its
distributors.

### Units and codes

| Unit | Contents | Code | Example |
|---|---|---|---|
| Batch | One flavour, one production run | 6 random characters issued by Velza to the plant's PC in advance | `Y53RSN` |
| Case (lot) | 4 packs × 6 cans = 24 cans | 15 characters: country + batch + flavour + lot number | `91Y53RSNOR00001` |
| Tray (lot) | 6 packs × 4 cans = 24 cans | Same format as a case | `91Y53RSNOR00004` |
| Pack | 6 cans (from a case) or 4 cans (from a tray) | Lot code + pack size + sequence, 17 characters | `91Y53RSNOR0000161` |

`91` = country code, `Y53RSN` = batch, `OR` = flavour (Original), `00001` = lot number within the batch.

- Lot numbers run `00001`–`1869F` in hexadecimal, so up to 99,999 lots per batch. A number is never reused, even when a
  lot is voided.
- Lot stickers (100 × 50 mm) carry a barcode and a QR code; pack stickers (75 × 25 mm) carry a barcode.
- Nobody types or edits a code; the system generates them all.

### Statuses

A case or tray moves as one sealed unit until it is opened; after that, its packs move one by one. An opened case or
tray still counts as a case or tray at the location that opened it (in My stock and on the HQ dashboard) while any of
its packs is still there.

| Status | Meaning | Set when |
|---|---|---|
| Generated | Codes allocated, stickers not printed | Operator creates a print order |
| Printed | Stickers printed | Operator prints |
| Packed | QC checked the lot and all its pack stickers | Supervisor/QC confirms |
| In transit | On its way to the next partner | Sender confirms dispatch |
| At SS / At DB / At Retailer | Received at that partner | Receiver scans it IN |
| Opened | Case or tray opened; packs now move individually | Retailer opens the lot (only Retailers open cases and trays) |
| Quarantined | Failed QC check; cannot move. Two ways out: Void (ends as Void for good), or reprint the bad sticker with a reason, which sends the lot back to Printed so QC verifies it again before it becomes Packed | QC confirms with missing or wrong packs |
| Void | Misprinted or unused stickers cancelled | Operator voids the lot |
| Damaged | Case, tray or pack damaged; leaves stock, cannot move, HQ alerted, public page says not for sale | Plant, SS, DB or Retailer reports it on its Damaged page, with a reason |
| Recalled | Batch withdrawn; cannot move, public page warns consumers | Velza HQ recalls the batch |

## Tree diagrams

### Partner tree

Velza Admin builds the tree and Velza HQ sees all of it. The Pune SS sees only its 50 distributors and the retailers
assigned to it directly; each distributor sees only its own retailers.

```
Velza Admin (builds)            Velza HQ (sees everything)
        │
Manufacturer (vietnam_plant) ──► any Super Stockist
        │
Super Stockist (pune_stocks)
 ├── Distributor (fc_road_db)
 │    ├── Retailer (JW Marriot)
 │    └── … its other retailers
 ├── Distributor (baner_db)
 │    └── … its retailers
 └── Retailer (Colaba Kirana)        ← assigned to the SS directly
```

### Code tree

Every pack code starts with its lot code, so scanning any pack shows which case or tray, batch and flavour it came from.

```
Batch Y53RSN (Original, one production run)
 ├── Case 91Y53RSNOR00001
 │    ├── Pack 91Y53RSNOR0000161   (pack size 6, sequence 1)
 │    ├── Pack 91Y53RSNOR0000162
 │    ├── Pack 91Y53RSNOR0000163
 │    └── Pack 91Y53RSNOR0000164
 └── Tray 91Y53RSNOR00004
      ├── Pack 91Y53RSNOR0000441   (pack size 4, sequence 1)
      └── … sequences 2–6
```

## Workflow

A lot leaves the plant only after QC has matched every pack sticker; a missing or wrong pack quarantines it. From then
on, each partner scans it OUT with an invoice and the assigned receiver scans it IN. Velza HQ sees every scan and can
recall a whole batch at any point.

```
Operator: New print order ─► Generated ─► Print ─► Printed
QC: scan lot + every pack ─► all match ─► Packed
                         └─► missing/wrong ─► Quarantined ─► Void
                                                        └─► Reprint (reason) ─► Printed ─► QC again
Plant: Dispatch (invoice) ─► In transit ─► SS: Receive ─► At SS
SS: Dispatch ─► In transit ─► DB: Receive ─► At DB ─► Dispatch ─► Retailer: Receive ─► At Retailer ─► Open lot ─► Opened
SS: Dispatch ─► its direct Retailer ─► At Retailer
Any stock-holding tier: Damaged (reason) ─► Damaged, HQ alerted
Velza HQ: Recall batch ─► Recalled everywhere; any later scan ─► BLOCKED_CODE alert
```

## Connection establishment

A new partner is connected in five Admin steps, and from then on every location connects through a browser and a
scanner, camera or keyboard.

### Onboarding a partner (Velza Admin)

1. **Partners → Register a partner:** tier, site name, contact person, place, address, city, state, PIN, phone and email.
   The system issues the next ID of the tier (MF0001, SS0001, DB0001, RT0001 …) and a sign-in with that ID; Admin shares
   the password.
2. **Assigned to:** link it to its parent in the same form. A distributor goes under a Super Stockist. A retailer goes
   under a distributor, or, by choosing Super Stockist in *Assigned to tier*, directly under its Super Stockist. Without
   this link, nobody can send it stock.
3. **Sign-ins & passwords:** each partner's sign-in is made with it (the plant gets MF0001-OP and MF0001-QC). Add Velza
   staff sign-ins (AD…, HQ…) or reset a forgotten password here.
4. **Devices (plants only):** register the plant PC. It immediately receives 10 batch codes and is topped up automatically.
5. **Settings (once):** sticker sizes, the public web address that QR codes open, and the alert threshold (default: not
   received within 3 days).

Each later hand-over then connects two partners on its own: the sender scans OUT with an invoice or challan number, and
only the assigned receiver can scan it IN. Anyone else who scans it gets a WRONG_RECEIVER alert at HQ.

### How each location connects

| Location | Device | Scanning | Volume |
|---|---|---|---|
| Manufacturer | Plant PC (registered device) | Webcam or phone camera now; a 2D USB scanner at the QC table is recommended | Highest: QC scans every lot and pack sticker |
| Super Stockist | Phone or PC | Phone camera on the lot QR code | Low: whole cases only |
| Distributor | PC, tablet or phone | Barcode scanner (USB or Bluetooth, keyboard mode) | Medium: whole cases only |
| Retailer | PC, tablet or phone | Barcode scanner | Medium; the only tier that opens cases into packs |
| Consumer | Own phone | Phone camera on the QR code; opens the public check page | — |

- Scanners act as a keyboard: they type the code and press Enter into the scan box, so no driver or setup is needed.
  Every scan screen also has **Use camera** and accepts typed codes.
- Network: the app runs in a browser. Phone cameras need an HTTPS address, which the production server will provide.
- Sign-in is switched off for development: anyone who opens the app can pick who to act as, so the app must stay on a
  private network, VPN or access gate; only the public QR page may be open to everyone. Switch sign-in on
  (`SIGN_IN=on`) before anyone outside the team uses it.

### Working offline at the plant

- The plant PC can be switched **Offline** and keep printing and verifying, using the batch codes it already holds.
- Offline lots are invisible to everyone else and cannot be dispatched until the PC is back **Online** and presses **Sync**.
- Pool refills happen only while the PC is online.
- Today this offline mode is a switch on the plant PC record, not a real offline app: if the internet or the server
  goes down, the plant's screens stop. See [Scale and readiness](#scale-and-readiness-2-crore-stickers) for the on-site
  plant server that fixes this.

## Roles and responsibilities

There are seven roles: two central roles at Velza Global India and five in the distribution line. Each role sees only
its own portal, the server refuses anything outside it, and everyone can change their own password on the Account page.

| Role | Belongs to | Responsible for | Portal screens |
|---|---|---|---|
| Velza Admin | Velza Global India | Setting up and maintaining the network: registering partners (with their IDs and sign-ins), assignments, passwords, plant devices, country and flavour codes, batch code pools, settings. Deactivates or deletes records that have no history. | Partners (registration form), Sign-ins & passwords, Devices, Countries & flavours, Batch code pools, Settings |
| Velza HQ | Velza Global India | Watching the whole chain: stock and status everywhere, investigating alerts (not received, wrong receiver, unknown or blocked codes), tracing any code, recalling a batch. Only role with the HQ dashboard. | Dashboard, Search code, Alerts, Batches & recall, Scan audit |
| Manufacturer Operator | A plant | Creating print orders and printing stickers, seeing every generated code per order, dispatching packed lots to Super Stockists with an invoice, reprinting damaged stickers (same code, reason logged), voiding misprints, keeping the plant PC synced. | New print order, Print orders (with Codes view), Dispatch, Reprint, Void lot, My stock, Damaged |
| Supervisor / QC | A plant | Checking that every pasted pack sticker belongs to its lot before anything leaves the plant: confirms to Packed, or the lot is quarantined. | Verify, My stock |
| Super Stockist | Its own company (one per state) | Receiving cases from the plant and dispatching them to its assigned distributors and to the retailers assigned to it directly. | Receive, Dispatch, My stock, Damaged, My partners |
| Distributor | Its own company | Receiving from its Super Stockist and dispatching to its assigned retailers. | Receive, Dispatch, My stock, Damaged, My retailers |
| Retailer | Its own shop | Receiving from its distributor (or its Super Stockist) and opening cases and trays for sale; the only role that opens them. Cannot dispatch. | Receive, Open lot, My stock, Damaged |
| Consumer (no login) | — | Scanning the QR code to check a product is genuine and not recalled. Sees no business data. | Public check page |

Every role that holds stock (plant, Super Stockist, Distributor, Retailer) also reports damaged cases, trays and packs
on its Damaged page. Scanning the lot code reports a whole case or tray, opened or not (an opened one takes the packs of
it still at that location); single packs can be reported once the lot is opened. Each Damaged page and the HQ dashboard
show the count as cases, trays and single packs.

## Database design (built, waiting for the database)

The database will have four tables linked by unique IDs: `partners`, `users`, `codes` and `code_history`. It is built
and tested: the app switches to PostgreSQL as soon as it gets the database's connection string, creates these tables
itself, and keeps using its data file until then. The schema is at version 2 (Retailer chain); a version 1 database
upgrades itself once its data is converted.

### Decisions

- **Registration:** only the Velza Admin registers partners, through one form, and has full rights to edit them.
- **One Super Stockist per state:** the form offers only states that don't have one yet.
- **IDs:** each partner gets an ID in sequence for its role. IDs are unique, are the primary keys, and are never changed
  or reused, even after a partner is deactivated.
- **Passwords:** the Admin sets the first password and shares it with the person. The person can change their own
  password, and nothing else. Passwords are stored scrambled (hashed), so nobody can read them back; a forgotten
  password is reset by the Admin.
- **Logins:** the login ID is the partner ID. The plant has two logins, one for the Operator and one for QC.
- **Visibility:** each login sees only its own dashboard. DB0001 can't see or log in as DB0002. A Super Stockist sees
  only its own distributors and its direct retailers; a distributor sees only its own retailers. The server checks this
  on every request.
- **Codes:** every print order saves its codes to the database, shows every field and the total sticker count, and
  syncs automatically. The plant PC holds codes while offline and syncs when back online.
- **Retailer assignment:** a retailer is assigned to one distributor or directly to one Super Stockist, chosen in the
  form's *Assigned to tier*. The Supplier tier no longer exists.
- **Old data:** `npm run db:convert-chain` converts data from the old chain: Outlets become Retailers under their
  Supplier's distributor, Suppliers and their sign-ins are removed (refused if a Supplier holds stock or history), and a
  backup is written first. The app refuses unconverted data.

### IDs per role

| Role | Login ID | Example |
|---|---|---|
| Manufacturer (plant) | MF + 4 digits, plus -OP or -QC | MF0001-OP (Operator), MF0001-QC (QC) |
| Super Stockist | SS + 4 digits | SS0001 (Maharashtra) |
| Distributor | DB + 4 digits | DB0001 (FC Road, Pune) |
| Retailer | RT + 4 digits | RT0001 (JW Marriot) |
| Velza Admin | AD + 4 digits | AD0001 |
| Velza HQ | HQ + 4 digits | HQ0001 |

The database issues the next number in one step, so two forms saved at the same moment can't get the same ID.

### How the tables connect

Each arrow points from a table to the table its ID refers to. `codes` says where each sticker is now; `code_history`
says everywhere it has been.

```
users.partner_id ───────────────► partners.partner_id
partners.parent_id ─────────────► partners.partner_id        (DB → SS; RT → DB or SS)
codes.manufacturer_id ──────────► partners.partner_id
codes.location_id / in_transit_to ► partners.partner_id
codes.lot_code ─────────────────► codes.code                  (pack row → its case/tray row)
code_history.code ──────────────► codes.code                  (kept even for unknown codes)
code_history.location_id, from_id, to_id ► partners.partner_id
code_history.login_id ──────────► users.login_id
```

### Table 1: partners

One row per site, filled from the Admin registration form. Manufacturer, Super Stockists, Distributors and Retailers
share this one table.

| Column | Example | Notes |
|---|---|---|
| partner_id (primary key) | DB0001 | From the role's sequence |
| partner_type | DB | MF, SS, DB or RT |
| name | FC Road Distributors | Site name |
| place | FC Road | Locality |
| address | Shop 12, FC Road | |
| city, state, pincode | Pune, Maharashtra, 411004 | One Super Stockist per state |
| contact_person | Name of the person at the site | |
| phone, email | Contact details | Unique, to block duplicates |
| parent_id | SS0001 | The partner it is assigned to: DB → SS; RT → DB, or RT → SS directly |
| status | Active | Active or Inactive |
| created_at, created_by | Time, Admin | |

### Table 2: users

One row per login. The plant has two; every other partner has one.

| Column | Example | Notes |
|---|---|---|
| login_id (primary key) | DB0001, MF0001-QC | The sign-in ID |
| partner_id | DB0001 | Links to partners; empty for Velza Admin and HQ |
| name | Asha Patil | The person |
| role | DB | ADMIN, HQ, OPERATOR, QC, SS, DB, RETAILER |
| password_hash | (scrambled) | Never stored as plain text |
| password_changed_at | time | When Admin set it or the person changed it |
| status, last_login_at | Active, time | |

### Table 3: codes

One row per sticker: a case or tray (lot) row and one row for each of its packs. The code must match its parts exactly,
so a code outside our structure can't be saved.

| Column | Lot row | Pack row | Notes |
|---|---|---|---|
| code (primary key) | 91AB12CDOR00001 | 91AB12CDOR0000161 | The full printed code |
| code_type | LOT | PACK | |
| country_code | 91 | 91 | 2 digits |
| batch_code | AB12CD | AB12CD | 6 characters |
| flavour | OR | OR | OR, GA, NS or MN |
| hex_code | 00001 | 00001 | 5-digit lot number in hex |
| lot_type | CASE | CASE | CASE or TRAY |
| pack_size | 6 | 6 | Cans per pack: 6 in a case, 4 in a tray |
| pack_sequence | (empty) | 1 | 1–4 in a case, 1–6 in a tray |
| lot_code | 91AB12CDOR00001 | 91AB12CDOR00001 | The case or tray the row belongs to |
| mfg_date, expiry_date | 2026-10-26, 2027-07-26 | same | |
| manufacturer_id | MF0001 | MF0001 | Links to partners |
| status | PACKED | PACKED | Current status |
| location_id, in_transit_to | MF0001 | MF0001 | Where it is now; links to partners |
| print_order_no, generated_at, generated_by | | | One generation run |
| synced, synced_at | Yes, time | Yes, time | Auto-sync |

A case gives 5 rows (1 lot + 4 packs) and a tray gives 7 (1 lot + 6 packs). A print order's total sticker count is its
number of rows: 10 cases and 5 trays = 85 stickers.

### Table 4: code_history

One row per event or scan, with the full code as scanned, never split. It is only ever added to; rows are never changed
or deleted.

| Column | Example | Notes |
|---|---|---|
| history_id (primary key) | 1048 | Auto-increasing |
| code | 91AB12CDOR00001 | Lot or pack code, as scanned |
| event | DISPATCHED | GENERATED, PRINTED, VERIFIED, QUARANTINED, REPRINTED, VOIDED, DISPATCHED, RECEIVED, OPENED, DAMAGED, RECALLED, SCAN_FAILED |
| location_id | MF0001 | Where it was at that moment |
| from_id, to_id | MF0001 → SS0001 | For dispatch and receive |
| status_before, status_after | PACKED → IN_TRANSIT | |
| invoice_no | INV-001 | |
| reason | Crushed in transit | For damage, reprint, void, quarantine and recall |
| result | OK | Or the error, e.g. WRONG_RECEIVER, UNKNOWN_CODE |
| login_id | MF0001-OP | Who scanned; links to users |
| device, event_time, synced | Plant PC 1, time, Yes | |

- Failed scans are kept: a fake or mistyped code that isn't in the codes table is still recorded, so HQ can spot
  counterfeits.
- A sealed case is recorded once, under its lot code. A pack's full history is its own rows plus its case's rows, found
  from the first 15 characters of the pack code.
- `codes` and `code_history` never disagree: each change to a code and its history row are saved together in one step.

## Scale and readiness (2 crore stickers)

The app is not yet ready for 2 crore stickers or for zero downtime at the plant: the code numbering is ready, the data
handling is not. Assessed on 27 Oct 2026; no code was changed.

| Area | Today | Needed before go-live |
|---|---|---|
| Code numbering | Ready: 99,999 cases or trays per batch and 6-character batch codes; 2 crore stickers is about 35–40 lakh cases and trays plus their packs | Nothing |
| Data file | Rewrites one file on every scan; too slow beyond about 1 lakh stickers | PostgreSQL in production |
| Whole-table loading | 19 places loaded whole tables into memory. **28 Oct 2026 (DEF-002):** HQ trace, alerts, My stock, My partners, Damaged, batch report, recall report, print-order codes, new print orders and partner delete now ask the store only for the rows they need (indexed filters). Still whole-table: the **HQ dashboard** (every synced case, tray and pack, to count stock per partner), the batch list (every case and tray of the listed batches) and the scan audit (every scan, to show the latest 300) | Counts in the database for the dashboard and batch list; `LIMIT`/pages for the scan audit, alerts and partner list |
| Plant offline | Only a switch; an internet or server outage stops printing | On-site plant server with its own database that syncs to the cloud |
| Updates | The server restarts | New version starts beside the old one; database changes work with both |
| Database failure | One database | Standby copy that takes over in about a minute |

### Zero downtime at the plant

- A small server inside the plant with its own database: printing, QC and dispatch keep working with no internet and
  sync when it is back.
- A cloud database with a standby copy.
- Updates with no downtime: switch to the new version only when it is healthy.
- A spare printer and scanner at the line, and a written step-by-step for "the screen is down".

### Testing plan

| Test | What it proves |
|---|---|
| Volume: 2 crore fake codes in a test database | Screens stay fast at real size |
| Load: every SS, DB and Retailer scanning at once (e.g. with k6) | No crash at peak hour |
| Soak: 24–48 hours at plant speed | No slow memory leak |
| Failure drills: cut the internet, restart the server, fail over the database mid-print | The plant keeps working; nothing lost or duplicated |
| Real line: printed stickers, real scanners, line speed, poor light | Scanning keeps up with production |
| Role checklist: one person per role | Each screen does what that person needs |
| Restore drill: restore yesterday's backup to a spare server | Backups actually work |

Today 283 automated tests (on the data file and on PostgreSQL; 267 before the QA dataset test was added on 28 Oct) and
a 12-step browser demo exist. *(28 Oct 2026: on the development PC the embedded-PostgreSQL test files time out while
starting — `Hook timed out in 10000ms` — so `npm test` is not green there; every JSON-store test and the 12-step browser
demo pass. Measured at 100,000 code records the JSON store misses the lookup and dashboard targets — see
[Part 4](#part-4--qa-test-data-and-scalability-28-oct-2026). Later on 28 Oct: after the DEF-002 remediation's new tests, 325 test runs
(249 JSON project + 76 PostgreSQL project) all pass with the PostgreSQL files run one at a time; the time-outs come from starting several
embedded databases at once on this PC — see [DEF-002 remediation](#def-002-remediation-28-oct-2026).)*

## Wrong scans and wrong stickers

Every mistake is caught at the scan and HQ is alerted; at the plant it can be fixed, but once stock has left the plant
there is no correction flow yet.

| Situation | What the app does |
|---|---|
| A pack from another case is scanned at QC | Refused on the spot: does not belong |
| A wrong sticker is confirmed at QC anyway | Lot quarantined → reprint with a reason → QC verifies again → Packed |
| A torn or misprinted sticker at the plant | Reprint (same code, reason logged) or Void |
| A case is scanned in at the wrong SS, DB or Retailer | Refused; HQ gets a wrong-receiver alert |
| An unknown or made-up code is scanned | Refused; HQ gets an unknown-code alert |
| A recalled, quarantined or void code is scanned | Refused; HQ gets a blocked-code alert |
| The same case is received twice | Refused as a duplicate |
| Dispatch to the wrong tier, an unassigned or an inactive partner | Blocked before dispatch |
| A damaged case, tray or pack | Reported with a reason; it stops moving and HQ is informed |
| A problem with a whole batch | HQ recalls the batch |

Every scan, right or wrong, is kept in the scan audit. **Not built yet:** relabelling a wrong sticker at an SS, DB or
Retailer, returning stock to the plant, cancelling a dispatch sent to the wrong place, and correcting a mistaken scan
(history can't be edited, by design). These need new flows with HQ approval (key note 13).

## Development and release

The code is on GitHub at `AbhayVelza/crms_velza_trace`: `main` holds the released state, and each developer works on
their own branch.

| Branch | Use |
|---|---|
| main | Released state; changed only through a reviewed pull request |
| develop/abhay | Abhay's working branch |
| develop/name | One per colleague, created from main |

1. Velza adds a colleague on GitHub: Settings → Collaborators.
2. The colleague clones the repo, creates `develop/name` from main, and runs `npm install` and `npm run seed` (their own data).
3. Each developer commits and pushes to their own branch.
4. Before a pull request, pull the latest main into the branch and run the tests.
5. Open a pull request into main; the other person reviews and merges.
6. Data files never go to GitHub; each developer keeps their own.

| Phase | What it added |
|---|---|
| UI (commit `8393c95`, 27–28 Oct 2026) | Velza Global brand redesign: brand-book colours, logo and Open Sans; light/dark/system themes; icon set; left sidebar shell. See [Part 3](#part-3--ui-redesign-velza-global-brand-2728-oct-2026) |
| 16 | Retailer chain without Suppliers; retailers under a distributor or directly under a Super Stockist |
| 15 | Sign-in switch for development |
| 14 | Damaged stock, opened-case counts, quarantine recovery |
| 13 | Codes view for every print order |
| 12 | Partner registration, readable IDs, sign-in |
| 11 | Database layer: PostgreSQL beside the data file |
| 1–10 | Prototype: print orders, QC, dispatch and receive, HQ dashboard, offline simulation, mobile scan screens |

---

# Part 2 — Plans and decisions

## Python backend plan (proposal, no code yet)

The backend moves to Python with FastAPI and PostgreSQL; the Next.js screens stay and call the same `/api` addresses,
so nobody using the app sees a change. Proposed on 27 Oct 2026 and waiting for approval before any code is written.

Only the backend is new: the screens and the database design stay, and the plant server (phase 7) lets printing
continue without internet.

```
Browser (Next.js screens, unchanged) ──/api──► Next.js forwards ──► FastAPI (Python) ──► PostgreSQL (cloud, standby)
                                                                         │
                                         Plant server (same image) ──────┴──► local PostgreSQL ⇄ sync to cloud
```

### Stack

| Layer | Choice | Why |
|---|---|---|
| Web framework | FastAPI on Python 3.12, run by uvicorn | Fast, request checking built in (Pydantic replaces zod), automatic API documentation page |
| Database access | SQLAlchemy 2 + psycopg 3 | Each screen asks PostgreSQL only for what it needs: filters, counts, pages and indexes, which fixes the 2 crore problem |
| Schema changes | Alembic migrations | Replaces the current schema version check; today's schema v2 becomes migration 1 |
| Database | PostgreSQL only | The JSON data file and embedded PostgreSQL are retired; local development uses PostgreSQL in Docker |
| Passwords and sessions | scrypt hashes, same `velza_session` cookie | Existing passwords and IDs keep working; nobody has to reset |
| Tests | pytest against a real PostgreSQL; Locust for load tests | The 267 unit tests are ported area by area; the 12-step browser demo stays unchanged and must pass after every phase |
| Frontend | Next.js, unchanged | Forwards `/api` to FastAPI; barcodes, QR codes and camera scanning stay in the browser, so nothing there is ported |
| Packaging | One Docker image | The same image runs in the cloud and on the plant server |

### Folder layout

```
backend/
  app/main.py            FastAPI app, routers, error handling
  app/api/               one router per area: auth, admin, print_orders, verify,
                         movement, damage, operator, trace, public
  app/services/          business actions (register partner, dispatch, recall …)
  app/core/              pure rules ported 1:1: codes, rules, alerts, permissions, ids
  app/db/                tables, sessions, Alembic migrations
  tests/                 pytest: core rules, each service, the store contract
```

### The 37 API routes, by area

| Area | Routes | Phase |
|---|---|---|
| Sign-in | login, logout, me, password, mode, dev-users, dev-login | 2 |
| Admin | partners and other records (list, create, edit, delete), batch code pools, settings, bootstrap | 2 |
| Plant | print-orders (list, create, one order, codes, printed), stickers, verify, reprint, void, devices, sync, demo-codes | 3 |
| Movement | dispatch, receive, open-lot, damaged, stock, my-partners | 4 |
| HQ and public | dashboard, alerts, lookup, batches, batch report, recall, scans, public check page | 5 |

### Phases

| Phase | Scope | Done when |
|---|---|---|
| 1. Foundation | FastAPI skeleton, PostgreSQL tables and Alembic, core rules ported with their tests, Next.js forwards one route at a time | Core rule tests pass in Python |
| 2. Sign-in and admin | Sign-in, sessions, registration form, sequential IDs, sign-ins and passwords | Registration and sign-in tests pass; browser demo 12/12 |
| 3. Plant | Print orders, codes view, QC verify, reprint, void, devices, batch code pool, sync | Plant tests pass; browser demo 12/12 |
| 4. Movement | Dispatch, receive, open lot, damaged, my stock, my partners | Movement and damage tests pass; browser demo 12/12 |
| 5. HQ | Dashboard, search and timeline, alerts, batches and recall, scan audit, public page, all written as database counts | HQ tests pass; browser demo 12/12 |
| 6. Scale and switch-over | Volume test with 2 crore codes, load, 24–48 hour soak, failure drills; every route on Python; the TypeScript backend removed | Every test in the testing plan passes |
| 7. Plant server | The same app with a local PostgreSQL inside the plant, syncing to the cloud | The plant keeps printing with the internet cut |

Each phase is merged into main only through a reviewed pull request, and the app keeps working between phases because
unported routes still run on the current backend.

> **UI note (28 Oct 2026):** the redesigned screens (Part 3) only call the existing `/api` routes, so this plan is
> unaffected. The browser demo the plan relies on passes 12/12 on the redesigned UI.

### Estimate and open points

- Rough effort for one developer: phases 1–6 about 4–6 weeks, phase 7 about 1–2 weeks. An estimate, not yet broken
  into tasks.
- Existing data moves once with an import script; old Supplier/Outlet data must be converted first.
- Hosting stays as planned (key note 2): the Python app needs the same small server and managed PostgreSQL.
- To decide: approve the plan and phase order; who on the team maintains Python code.

## Key notes to discuss

Items 1–3 and 11–12 decide when the system can go live: sign-in, a real database, safe network access, scale to
2 crore stickers, and zero downtime at the plant. The rest shape how the chain works day to day.

| # | Topic | Where we are | To decide | Status |
|---|---|---|---|---|
| 1 | Sign-in | Built, but switched off while the app is being developed: people pick who they are instead of signing in (portal rules still apply). When on, everyone signs in with their partner ID and the password Velza Admin shared, and can change only their own password. | When to switch sign-in on (one setting, `SIGN_IN=on`); it must be on before anyone outside the development team uses the app. Optional extras: force a password change at first sign-in; two-factor sign-in for Velza Admin and HQ. | Open |
| 2 | Database and hosting | PostgreSQL connection built and tested with the full demo; it switches on when the connection string is set. Until then data is in a file on one PC. Recommended: AWS Mumbai — Lightsail server + managed PostgreSQL for the pilot (about ₹2,800/month with GST), more capacity with a standby database for the full rollout (about ₹6,300–8,900/month). Approximate figures, not yet checked on AWS's calculator. | Confirm provider and budget; backup schedule and retention. | Open |
| 3 | Network access until sign-in | Anyone who can open the app can act as any user. Security headers, rate limits and cross-site protection are in place. | Office network, VPN or an access gate (e.g. Cloudflare Access); who may reach it. | Open |
| 4 | Country code per plant | Every code starts with the country code; the default is 91 (India), also used by vietnam_plant today. | Country of manufacture or market of sale? A non-India plant may need its own code (e.g. 84). | Open |
| 5 | Plant → Super Stockist assignment | Any plant can dispatch to any Super Stockist. | Should each Super Stockist also be assigned to one plant? | Decided |
| 6 | Damaged and returned stock | Damage reporting is built: every stage reports damaged cases, trays or packs on its Damaged page, and HQ gets an alert. Returns have no screen yet, and Damaged has no undo. | What happens to damaged stock (write-off, return to plant, credit note), who can correct a wrong report, and how returns work. | Decided |
| 7 | Who opens cases | Only Retailers can open a case or tray into packs; Super Stockists and Distributors ship sealed cases and trays. | Do Distributors, or Super Stockists supplying retailers directly, ever need to split cases? | Open |
| 8 | End of the chain | Tracking ends when the Retailer receives or opens the stock. | Should retailers record sales, or is receipt enough? | Open |
| 9 | Scanning hardware | Camera at the plant and SS; scanners at Distributors and Retailers. | Budget and timing for a 2D USB scanner at the plant QC table (highest volume). | Open |
| 10 | Alert timing | Stock in transit for more than 3 days raises a Not-received alert. | The right threshold per leg (plant → SS may differ from Distributor → Retailer). | Open |
| 11 | Scale to 2 crore stickers | Not ready, now measured (28 Oct): at 100,000 code records a lookup takes 4.3 s and the HQ dashboard 9.2 s on the JSON store, because services read whole tables (DEF-002, Part 4). | When to schedule the scale work and the load tests before go-live. | Open |
| 12 | Zero downtime at the plant | Offline mode is only a switch; an internet or server outage stops the plant today. | On-site plant server with its own database that syncs to the cloud; spare printer and scanner; downtime procedure. | Open |
| 13 | Wrong stickers after stock leaves the plant | Caught and alerted, but there is no relabel, return-to-plant or cancel-dispatch flow (see Wrong scans and wrong stickers). | Which correction flows to build, and who approves them (HQ?). | Open |
| 14 | Source code and teamwork | Code on GitHub; each developer works on their own branch and merges into main through a reviewed pull request. | Turn on branch protection for main. | Decided |
| 15 | Backend in Python | Plan written (see Python backend plan); no code yet. The current TypeScript backend keeps running. | Approve the plan and phase order; who maintains the Python code. | Open |
| 16 | UI redesign (new, 28 Oct 2026) | Velza Global brand redesign committed on `develop/aditya` as `8393c95` (not pushed; see Part 3). Browser demo 12/12 passes on it. | Push and open a pull request into main; keep or change the sign-in panel tagline; clear the 6 test scan records on the redesign PC. | Open |
| 17 | QA findings (new, 28 Oct 2026) | End-to-end QA done (Part 4): roles, hierarchy and traceability pass; 18-partner Maharashtra dataset in `data/qa-mh-2026.json`. Defects: DEF-002 (P1, scale), DEF-001 (P3, settings readable without sign-in), DEF-003, DEF-004 (P3). | Approve fixes for DEF-001/DEF-002; decide PIN/state validation (INFO-1). | Open |

---

# Part 3 — UI redesign: Velza Global brand (27–28 Oct 2026)

The screens were redesigned to match the official **Velza Global Brand Book** and velzaglobal.com, in four passes.
It is a presentation-only change: no route, API, permission, rule, form field, status value, sticker size or test
changed. Committed on branch `develop/aditya` as `8393c95` (28 Oct 2026; not pushed).

## Brand sources and rules applied

Source: *Velza Global Brand Book* (PDF, 33 pages) and the live site velzaglobal.com.

| Brand book rule | Page | How it is applied in the CRM |
|---|---|---|
| Colours: Black `#000000`, White `#FFFFFF`, Neutral Grey `#777777`, Light Neutral `#F5F5F3` — "monochrome by design" | 24 | All UI neutrals are tints between these four (see tokens). No decorative colour. |
| White/black-led for operational communication; dark/white-led for digital | 25 | Light theme: Light Neutral page, white cards, black primary buttons. Dark theme: near-black surfaces, white primary buttons. |
| Logo: black (positive) on light, white (reversed) on dark; never redrawn, recoloured, distorted or given effects | 15–18, 23 | Master artwork extracted from the PDF unchanged (cropped only). Black version on light, white on dark. Always rendered with `object-contain`, so it cannot be stretched. |
| V symbol alone for small digital use and favicons | 19, 21 | Sidebar, collapsed rail, mobile header, public page and favicon use the V symbol. The full lock-up (V + VELZA + GLOBAL) appears only large, on the sign-in page. |
| Clear space around the logo = height of the V | 20 | The gap between the V and the "Traceability" text equals the V height (e.g. 26 px V → 26 px gap). |
| V as a tonal "watermark device" | 7, 19 | One oversized V at 7% opacity in the sign-in page's black panel. |
| Typography: Open Sans (alternative corporate font) — headline Bold, subhead Bold, body/caption Regular; Trebuchet MS is the corporate font | 26 | Open Sans bundled with the app (no internet needed); Trebuchet MS is the first fallback. |

Brand-book gaps filled with restrained choices (documented, not from the book): button shape (pill, as on
velzaglobal.com), radii (8 px controls, 12 px cards), motion timings, and muted semantic colours for statuses.

## Design tokens (`src/app/globals.css`)

Light theme (`:root`, `.theme-light`) and dark theme (`[data-theme="dark"]`, `.theme-dark`), exposed to Tailwind v4 as
utilities (`bg-surface`, `text-muted-foreground`, `border-line`, `bg-primary`, `text-danger` …).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#f5f5f3` (brand Light Neutral) | `#0a0a0a` | Page |
| `--surface` | `#ffffff` (brand White) | `#141414` | Cards, sidebar, header |
| `--surface-2` / `--muted` / `--muted-strong` | `#fafaf9` / `#efefec` / `#e4e4e0` | `#191919` / `#212121` / `#2c2c2c` | Table heads, hover, selected |
| `--line` / `--line-strong` | `#e4e4e0` / `#cbcbc6` | `#2a2a2a` / `#3d3d3d` | Borders, dividers |
| `--foreground` / `--foreground-2` | `#0a0a0a` / `#2e2e2e` | `#f5f5f3` / `#dcdcd8` | Text |
| `--muted-foreground` | `#5c5c5c` | `#a6a6a2` | Secondary text (brand `#777777` is 4.48:1 on white, so kept for large/tertiary text only) |
| `--subtle-foreground` | `#777777` (brand Neutral Grey) | `#8a8a86` | Tertiary text, placeholders |
| `--primary` / `--primary-foreground` | `#000000` / `#ffffff` | `#f5f5f3` / `#000000` | Primary buttons, active states |
| `--success` (+ `-soft`, `-line`) | `#1d6b3a` | `#7fd19b` | At retailer, scan OK |
| `--warning` (+ `-soft`, `-line`) | `#855400` | `#e9b860` | In transit, quarantined, unsynced |
| `--danger` (+ `-soft`, `-line`, `-hover`, `-foreground`) | `#b42318` | `#ff8a80` | Alerts, failed scans, damaged, recalled, recall button |
| `--ring` | `#000000` | `#f5f5f3` | Keyboard focus outline (2 px, offset 2 px) |
| `--container-app` | 100 rem (1600 px) | | Maximum content width |
| `--radius-control` / `--radius-card` | 0.5 rem / 0.75 rem | | Inputs, buttons / cards |

Print: under `@media print` everything falls back to white paper and black text. The print preview (`/print/…`) is
always light (`.theme-light`), whatever the app theme is.

## Logo and font assets

| File | What it is |
|---|---|
| `src/components/brand-assets/velza-logo-black.png` | Full lock-up, black (positive), 582 × 753 px, transparent background |
| `src/components/brand-assets/velza-logo-white.png` | Full lock-up, white (reversed) |
| `src/components/brand-assets/velza-v-black.png` | V symbol, black, 582 × 500 px |
| `src/components/brand-assets/velza-v-white.png` | V symbol, white |
| `src/app/favicon.ico` | Black V on a white tile, 16–64 px (replaced the stock Next.js icon); fallback for browsers without SVG favicons |
| `src/components/brand-assets/velza-favicon.svg` | Main favicon: V symbol only, **transparent background**; black V when the browser is in light mode, white V in dark mode (brand book positive/reversed rule). Linked from `src/app/layout.tsx` metadata as a static import, so it is served from `/_next/static/` and shows on the sign-in page too |
| `src/app/fonts/OpenSans-Variable.ttf` + `OFL.txt` | Open Sans variable font (weights 300–800) from github.com/google/fonts, SIL Open Font License 1.1 |

- The logo images are **static imports** (served from `/_next/static/media/…`), because `src/proxy.ts` sends
  signed-out requests for other paths to `/login`. This keeps the logo visible on the sign-in page and the public QR page
  without changing the proxy.
- `src/components/brand.tsx` provides `<VelzaSymbol>` and `<VelzaLogo>` with `tone` = `auto` (follows the theme),
  `on-light` or `on-dark`.

## Themes: light, dark, system

- **Switcher** (`src/components/ThemeSwitcher.tsx`): three buttons — Light, Dark, System — in the header and on the
  sign-in page. Keyboard accessible (radio group, each with an accessible name and tooltip).
- **Saved** in this browser only (`localStorage` key `velza-theme`); System follows the device setting live.
- **No flash:** an inline script in `<head>` (`src/components/themeScript.ts`, used by `src/app/layout.tsx`) sets
  `<html data-theme>` before the first paint. The existing Content Security Policy already allowed inline scripts, so
  `next.config.ts` did not change.
- Switching changes no React state, makes no API call and does not reset forms. Colours fade for 180 ms, instantly when
  the device asks for reduced motion.

## Application shell: left sidebar (`src/components/Sidebar.tsx`, `AppHeader.tsx`)

| Area | What it shows |
|---|---|
| **Sidebar** (256 px) | V symbol + "Traceability" (links to the portal home), the portal name, then the role's menu from `src/lib/menu.ts` with a 20 px icon per item. Active page: light highlight + thin black bar on its left edge. |
| **Collapsed rail** (76 px) | Icons only; each item's label appears as a tooltip on hover or keyboard focus. Toggled with the panel button in the header; saved in this browser (`velza-sidebar`), applied before first paint. |
| **Header** (65 px) | Left: where you are — *portal › page* (the portal part links to `/`). Middle: signed-in name, ID and organisation. Right: Role and User selects (sign-in off) or Account and Sign out (sign-in on), then the theme switcher. |
| **Operator only** | Device status (Online/Offline, unsynced lots, Sync, pool size) on a slim second header row. |

Responsive behaviour (tested in a browser at each width):

| Width | Layout |
|---|---|
| ≥ 1280 px | Sidebar always visible (collapsible); header is one row |
| 1024–1279 px | Sidebar always visible; header in two rows (page + theme, then the selects) so nothing overflows |
| < 1024 px (tablet, phone) | Sidebar becomes a drawer opened by the ☰ button. Closes on Escape, the close button, a tap outside, or choosing a page. Page behind doesn't scroll while open; focus moves into it; while closed it is `inert` (Tab can't reach hidden links). |

Menu labels, hrefs and permissions still come only from `src/lib/menu.ts`; the sidebar renders `MENU[role]`, so each
role sees exactly what it saw before. There is still exactly one `<nav>` element (the browser demo checks it).

## Icons (`src/components/icons.tsx`)

One outline set, 24-unit grid, 1.75 stroke, inlined in the code (geometry follows Lucide, ISC licence) — **no new npm
package**, because installing one would have rewritten an uncommitted `package-lock.json` change. Icons are hidden from
screen readers; the text beside them carries the meaning, so no button or link changed its accessible name.

| Menu destination | Icon | Menu destination | Icon |
|---|---|---|---|
| Dashboard | layout grid | Receive | inbox |
| Search code | search | Dispatch | truck |
| Alerts | bell | Open lot | open package |
| Batches & recall | package | My stock | warehouse |
| Scan audit | scan frame | Damaged | octagon alert |
| Partners | building | My partners / My retailers | users |
| Sign-ins & passwords | key | New print order | file plus |
| Devices | chip | Print orders | clipboard list |
| Countries & flavours | globe | Reprint | rotate |
| Batch code pools | database | Void lot | circle slash |
| Settings | sliders | Verify | list checks |

Sizes: sidebar 20 px, header/page actions 16–18 px, portal home cards 24 px, theme switcher 17 px, status icons 16 px.
Status meaning: ✓ circle-check = OK, ✗ circle-x = failed, triangle = warning/alert, ban = blocked.

## Shared components (`src/components/ui.tsx`)

Every export and prop kept; additions are optional.

| Component | Change |
|---|---|
| `PageTitle` | 30 px bold heading, 15 px subtitle |
| `Card` | 12 px radius, 24 px padding, 18 px bold title; still a `<section>` (the browser demo uses it) |
| `Button` | Pill shape; primary black/white, secondary outlined, danger red, ghost; hover, 75 ms press feedback, focus ring; **new optional `loading`** shows a spinner and disables it; a caller's `min-h-*` is now honoured (before, compact buttons were always 40 px) |
| `Field`, `Input` | 14 px labels, 13 px hints; border + soft ring on focus; a caller's `w-*` is honoured |
| `Select` | Still the native `<select>` (keyboard and phone pickers unchanged) with one chevron icon in both themes; **new optional `wrapperClassName`** |
| `Notice` | Icon per tone (ok, error, warn, info), fades in |
| `StatusBadge` | Pill with a status dot, label unchanged: neutral for normal states, green *At retailer*, amber *In transit / Quarantined*, red *Damaged / Recalled*, struck-through *Void* |
| `Pill` (new) | Small label used for counts and flags (alert counts, unsynced, device status) |
| `Loading` (new) | Spinner + text for existing loading states; since 28 Oct it fades in after 150 ms, so a fast load shows nothing instead of a flash |
| `Skeleton`, `LoadingPage` (new, 28 Oct) | Placeholder blocks shaped like the content (slow pulse, static under reduced motion) under the real page title, with one screen-reader "Loading …" status; used where a page has a genuine load (HQ dashboard); `actions` shows the page's own buttons (disabled) and the subtitle placeholder wraps like the real one on phones, so nothing moves when data arrives (measured 0 px shift at 360–1440 px) |
| `useAction` (new hook, 28 Oct, `useAction.ts`) | Runs a save/submit at most once at a time: a second click while it is in flight is ignored and `busy` drives `<Button loading>`. Request, payload and error handling unchanged |
| `Table`, `Td`, `Empty`, `Stat` | 12 px uppercase table heads, roomier rows with hover, 30 px stat numbers, larger empty states |

## Screens covered

All 31 screens, in both themes: portal home; HQ dashboard, search code (with `?code=` deep link), alerts, batches &
recall, scan audit; Admin partners, sign-ins & passwords, devices, countries & flavours, batch code pools, settings;
Operator new print order (step indicator), print orders, order codes, reprint, void lot; QC verify (checklist ticks);
receive, dispatch, open lot, my stock, damaged, my partners/retailers; account; sign-in page (black brand panel on wide
screens); public QR check page; print view (toolbar only — sticker markup and millimetre sizes untouched).

## Motion and accessibility

- Transitions 75–220 ms: button colour and press, nav and sidebar hover/active, sidebar width, drawer slide and backdrop,
  tooltip fade, card hover lift (2 px, only on cards that are links), notice entrance, disclosure fade, theme colours.
- `prefers-reduced-motion`: all animation and the theme fade are switched off.
- **Motion tokens (28 Oct)** in `globals.css`: `--duration-fast` 120 ms (hover/press), `--duration-base` 180 ms (state
  changes, entrances), `--duration-panel` 220 ms (drawers, overlays), `--ease-out-soft`, `--ease-in-out-soft`; utilities
  `animate-fade-in`, `animate-rise-in`, `animate-fade-in-late` (150 ms delay, for loading indicators), `animate-skeleton`.
  Only opacity and transform are animated.
- **Page fade (28 Oct):** `PageFade` (`src/components/PageFade.tsx`) eases the page content in over 180 ms when the path
  changes — opacity only, nothing remounts, navigation is not delayed, not on first load, search-param changes on the
  same page do not replay it, skipped under reduced motion. (A `template.tsx` was not used: it remounts only when the
  top-level segment changes and resets page state.)
- **Mobile drawer focus (28 Oct):** while the drawer is open, Tab and Shift+Tab cycle inside it (before, focus moved to
  the page behind the backdrop); Escape and focus return to the menu button as before.
- **Busy buttons (28 Oct):** every save/submit shows a spinner while its request runs and ignores a second click —
  settings, account password, void, reprint, recall, pool issue, new sign-in, reference-data add/delete/password, and
  (spinner only, they already blocked repeats) dispatch, partner registration and QC confirm.
- Visible focus outline on every link and button; inputs show a border + ring instead.
- On scan pages the scan box still refocuses itself after a blur, except when focus moves to another field or into the
  menu drawer (so the drawer is usable from the keyboard).

## Files

| File | Change |
|---|---|
| `src/app/globals.css` | Tokens, themes, Tailwind variants (`dark`, `sidebar-collapsed`), focus, reduced motion, print |
| `src/app/layout.tsx` | Open Sans, `<html data-theme>`, inline theme/sidebar script |
| `src/app/(screens)/layout.tsx` | Sidebar + header + page shell |
| `src/app/(screens)/page.tsx` | Portal home cards |
| `src/app/login/page.tsx`, `src/app/t/[code]/*`, `src/app/print/**` | Sign-in, public page, print view styling |
| `src/app/(screens)/**/page.tsx` (24 pages) | Colours to tokens, icons, spacing — no logic changes |
| `src/components/AppHeader.tsx`, `ActAs.tsx`, `DeviceBar.tsx`, `RoleGate.tsx`, `ScanInput.tsx`, `StockTable.tsx`, `AdminCrud.tsx`, `GeneratedCodes.tsx`, `PrintView.tsx`, `ui.tsx` | Restyled; `ActAsSwitcher` gained an optional `className` |
| New: `Sidebar.tsx`, `ThemeSwitcher.tsx`, `themeScript.ts`, `brand.tsx`, `icons.tsx`, `brand-assets/`, `src/app/fonts/` | Shell, theming, logo, icons, font |
| `src/app/favicon.ico`, `brand-assets/velza-favicon.svg` | Velza V favicons (white tile fallback; transparent adaptive SVG) |

**Not changed:** `src/lib/**` (incl. `menu.ts`), `src/app/api/**`, `src/proxy.ts`, `next.config.ts` (security headers,
CSP), `tests/**`, `scripts/`, `db/`, `Stickers.tsx` sticker markup and sizes, `package.json`. No dependency added.

## Verification

Run on 28 Oct 2026 in an isolated copy of the project (its own data file, port 3100/3200), so the developer's
`npm run dev` and `data/db.json` were not touched.

| Check | Result |
|---|---|
| `npm run lint` | Pass |
| `npm run typecheck` | Pass |
| `npm run build` (production) | Pass |
| `npm run test:e2e` (12-step browser demo, Edge, 1280 × 900) | **12 / 12 pass** on the final UI, incl. sticker barcode/QR decoding, portal isolation, recall, offline sync, sign-in/out |
| `npm test` (unit) | 209 passed; the embedded-PostgreSQL suites time out starting on this PC (`Hook timed out in 10000ms`), exactly as in the baseline before the redesign. No tested code changed. |
| Browser review | Every role's menu matches `menu.ts`; widths 390, 768, 1024, 1152, 1280, 1366, 1440, 1920 px; light and dark; no sideways scrolling; no console or hydration errors |

## Open items from the redesign

- **Commit:** committed as `8393c95` on `develop/aditya` (not pushed); push and merge into main through a pull request.
- **Test scan records:** 6 `UNKNOWN_CODE` scan-audit records were created on the redesign PC's local data during visual
  checks (lookups of the demo made-up code). `npm run clear-activity` removes them; not run without approval.
- **Tagline:** the sign-in panel's line "Every case, tray and pack — from plant to retailer." was written for the
  redesign; keep or change.
- **Real devices:** layouts were checked in browser windows at phone/tablet widths, not on physical devices.
- **Pre-existing, not fixed (presentation only, logged for later):** `/hq/alerts` briefly shows "No alerts" while
  loading; the dashboard's "Counts by status" table has no empty-state message; the PC runs Node 22 while the README asks
  for Node 24.
- `.stperson` (mentioned in a brief) does not exist in the code or tests; the selectors the tests use (`#scan-input`,
  `.sticker`, `data-testid`s, labels, button names) are all preserved.

---

# Part 4 — QA, test data and scalability (28 Oct 2026)

End-to-end QA of the implementation at commit `8393c95` on `develop/aditya`. Detail and evidence:
[docs/QA_REPORT.md](docs/QA_REPORT.md), [docs/SCALABILITY_REPORT.md](docs/SCALABILITY_REPORT.md),
[docs/MANUAL_QA_GUIDE.md](docs/MANUAL_QA_GUIDE.md), [docs/qa/](docs/qa/). Facts below are **verified** (run or read in
the code) unless marked otherwise.

## Repository, stack and environment (verified)

| Item | Value |
|---|---|
| Repo / branch | `C:\Users\ADMIN\Desktop\crms_velza\crms_velza_trace`, `develop/aditya`; remote `AbhayVelza/crms_velza_trace`. The only long-standing local change is `package-lock.json` (unrelated, never committed or modified by QA) |
| Stack | Next.js 16.4.3 (App Router, Turbopack), React 19.3, TypeScript, Tailwind CSS 4.3, zod 4; route handlers in `src/app/api` → services in `src/lib/services` → rules in `src/lib/core` → `Store` (`src/lib/store`) |
| Store | JSON file by default (`data/db.json`, or `VELZA_DB_PATH`); PostgreSQL when `DATABASE_URL` is set; embedded PostgreSQL (`STORE=pglite`) for tests. No ORM: hand-written SQL in `src/lib/store/sql`, schema version check instead of migrations (`npm run db:migrate`, `db/schema.sql`) |
| Auth | Session cookie `velza_session` (HttpOnly, SameSite=Lax, 12 h), scrypt password hashes, lock for 5 min after 5 wrong passwords; `SIGN_IN=on/off` (off by default under `npm run dev`) |
| Authorization | `PERMISSIONS` in `src/lib/core/permissions.ts`, enforced by `requireAction` in every service; data scope by partner in the services; `src/lib/menu.ts` drives the menu and the client-side "not part of your portal" message |
| Environment variables (names only) | `DATABASE_URL`, `PG_POOL_MAX`, `VELZA_ADMIN_PASSWORD`, `VELZA_HQ_PASSWORD` (`.env.example`); also `STORE`, `VELZA_DB_PATH`, `PGLITE_DIR`, `SIGN_IN`, `HTTPS_ONLY`, `RATE_LIMIT_PER_MIN`, `RATE_LIMIT_WRITES_PER_MIN`, `RATE_LIMIT_PUBLIC_PER_MIN`, `RATE_LIMIT_GLOBAL_PER_MIN`, `NEXT_PUBLIC_DEMO_HELPER`. No `.env.local` on the QA PC |
| Side effects | None: no e-mail, SMS, webhooks or outbound calls |
| Dev PC | Windows 11, 8 GB RAM, Node 22.13.1 (README asks for Node 24) |

## Commands (all run on 28 Oct 2026)

| Purpose | Command | Result on the QA PC |
|---|---|---|
| Lint | `npm run lint` | pass |
| Typecheck | `npm run typecheck` | pass |
| Unit (json + postgres projects, 283 tests) | `npm test` | all JSON-store tests pass; embedded-PostgreSQL files time out at start-up on this PC (`Hook timed out in 10000ms`, environmental, also before QA) |
| New dataset unit test | `npx vitest run tests/unit/maharashtraDataset.test.ts` | 8/8 on JSON; 8/8 on PostgreSQL when run alone |
| Build + 12-step browser demo | `npm run test:e2e` | 12/12 (2.4 min) |
| QA server (own data file, sign-in ON) | `node tests/qa/startQaServer.mjs [start]` | port 3300, `data/qa-mh-2026.json` |
| Live API QA (creates/verifies the 18 partners) | `QA_BASE=http://localhost:3300 npx tsx tests/qa/qaRun.ts` | 87 PASS, 1 FAIL (DEF-001), 1 NEEDS INVESTIGATION (INFO-1) |
| Browser QA, all 7 roles | `QA_BASE=http://localhost:3300 node tests/qa/qaUi.mjs` | 64 PASS, 1 NOT RUN (no search/sort/paging exists) |
| Performance data / benchmark | `node tests/qa/perfGenerate.mjs --codes N --out <file>`, `node tests/qa/perfBench.mjs …` | see Scalability below |

## Roles and verified permission boundaries

126 live requests (7 roles × 18 APIs, sign-in ON) all matched `PERMISSIONS`. Summary:

| Role | Can (server-verified) | Cannot |
|---|---|---|
| Velza Admin | partners, sign-ins, devices, reference data, pools, settings (create/edit/delete with history rules) | HQ dashboard, trace, stock, dispatch |
| Velza HQ | dashboard, alerts, scan audit, batches, trace any code, recall | any admin API, any partner action |
| Operator | print orders, reprint, void, devices, dispatch to any SS, stock, damaged; its own plant's batches | admin, HQ, verify, receive |
| QC | verify, stock; its plant's batches | everything else |
| Super Stockist | receive, dispatch to its assigned DBs/direct retailers, stock, damaged, my partners | other SS's partners, admin, HQ, trace |
| Distributor | receive, dispatch to its 2 assigned retailers, stock, damaged, my retailers | other DBs' retailers, admin, HQ, trace |
| Retailer | receive, open lot, stock, damaged | dispatch, partner lists, trace, admin |

Bootstrap data is scoped (non-staff get only their own partner). Pages of another portal load their shell but show
"not part of your portal"; the API refuses their data (the API is the security boundary).

## QA dataset: 18 Maharashtra partners

Defined in `tests/qa/maharashtraDataset.ts`, created through `POST /api/admin/partners` into `data/qa-mh-2026.json`
(git-ignored), verified by API and file read. Full table: [docs/qa/maharashtra-test-data.md](docs/qa/maharashtra-test-data.md).

```
MF0001  QA-MH-2026-MFG-001 Sahyadri Beverages Plant (Chakan, Pune)      — supplies any SS
SS0001  QA-MH-2026-SS-001 Deccan Super Stockist (Pune)
 ├─ DB0001 DST-001 Shivajinagar (Pune)      → RT0001 Kothrud, RT0002 Baner
 ├─ DB0002 DST-002 Nashik Valley (Nashik)   → RT0003 Gangapur Road, RT0004 Nashik Road
 └─ DB0003 DST-003 Andheri (Mumbai)         → RT0005 Powai, RT0006 Dadar
SS0002  QA-MH-2026-SS-002 Konkan Coast Super Stockist (Panaji, Goa)
 ├─ DB0004 DST-004 Kolhapur                 → RT0007 Rajarampuri, RT0008 Ichalkaranji
 └─ DB0005 DST-005 Solapur                  → RT0009 Hotgi Road, RT0010 Pandharpur
```

- Expected = actual: 1 MF, 2 SS, 5 DB, 10 RT = 18; no duplicates; no broken parents; every sign-in present.
- **Deviation:** SS-002 is in Goa because the app allows one Super Stockist per state (a second Maharashtra SS is
  refused — tested). The other 17 are in Maharashtra.
- **Rerun:** `qaRun.ts` finds records by their QA code (start of the name) and creates only what is missing; the scan
  chain is created once. **Cleanup** (only on request): delete `data/qa-mh-2026.json` and the credentials file.
- **Credentials:** `data/qa-mh-2026-credentials.json` (git-ignored, random). Never put passwords in docs or tickets.

## Defects and observations

| ID | Severity | Summary | Status |
|---|---|---|---|
| DEF-002 | P1 | Lookups, dashboard, alerts, my-partners and stock read whole tables; too slow at 100k records | **Partly fixed 28 Oct** (uncommitted) — dashboard still over target at 100k; see [DEF-002 remediation](#def-002-remediation-28-oct-2026) |
| DEF-005 | P2 | PostgreSQL only: concurrent HQ lookups of a code aborted each other (serialization failures, 30–53 % at 10 concurrent) | **Fixed 28 Oct** (uncommitted), same change |
| DEF-001 | P3 | `GET /api/admin/settings` answers without sign-in (config only; writes are protected) | Open — needs approval (authorization change) |
| DEF-003 | P3 | With sign-in ON every page logs a console 404 (`/api/auth/dev-users` probe) | Open |
| DEF-004 | P3 | Partner table: no search, sort or pagination | Open |
| INFO-1 | — | PIN code not checked against the state | Decision needed |
| INFO-3 | — | Partner names are not unique (phone and e-mail are) | Noted |
| INFO-4 | — | Embedded-PostgreSQL unit tests time out at start-up on low-memory PCs | Cause established 28 Oct (parallel PGlite start-up > 10 s hook timeout; pass one file at a time); config change needs approval |

Security results that passed: 401 without a session; 403 for every out-of-role API; refused writes leave data unchanged;
deactivation ends open sessions; logout invalidates the cookie; cross-site writes, non-JSON bodies, malformed JSON and
bodies > 256 KB refused; public QR page shows no business data; injection-style codes handled safely; audit history has
no edit/delete API.

## Scalability (measured)

JSON store, production build, same-machine client, sequential p50 / p95:

| Code records | Exact lookup | Dashboard | Partner list | Write (dispatch scan) | Server memory |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 64 / 97 ms | 45 / 55 ms | 9 / 12 ms | 42 / 65 ms | 165 MB |
| 10,000 | 246 / 392 ms | 233 / 271 ms | 7 / 14 ms | 172 / 234 ms | 469 MB |
| 100,000 | **4,288 / 5,630 ms** | **9,215 / 10,589 ms** | 51 / 65 ms | 2,219 / 2,616 ms | peak 1,176 MB |

**Verdict: FAIL — MEASURED** for 100k on the JSON store (targets: lookup p95 ≤ 200 ms, dashboard ≤ 1 s). PostgreSQL:
**not load-tested** (no server available); the slow paths are whole-table reads in the services (e.g.
`src/lib/services/trace.ts:47` loads the entire movement ledger for one lookup), so PostgreSQL alone is not expected to
fix them. The existing SQL indexes fit the needed filtered queries. See the Scalability report for the fixes and what
must be measured before any capacity claim.

## DEF-002 remediation (28 Oct 2026)

Later the same day the whole-table reads were fixed where the cause was confirmed in the source, and everything was
re-measured — on the JSON store and, for the first time, on a real **PostgreSQL 17.3 server** (a private local
cluster). Uncommitted, on `develop/aditya`. Detail: [docs/SCALABILITY_REPORT.md](docs/SCALABILITY_REPORT.md) Part A,
[docs/QA_REPORT.md](docs/QA_REPORT.md) §14, raw results [docs/qa/def-002/](docs/qa/def-002/).

**How the code now reads data.** The store filter accepts a list ("any of": `{ locationId: [ids] }` → SQL
`location_id = ANY(...)`, same behaviour on the JSON store), so a screen can ask for exactly the rows it needs in one
query instead of loading a table or querying once per partner:

| Screen / API | Reads now |
|---|---|
| HQ trace (`lookup`) | the code's own history (lot + pack) and batch-wide events by code, its reprints, its packs, names only for the partners/users/devices shown. Reads outside a transaction; the `LOOKUP` audit scan is then written on its own (fixes DEF-005) |
| HQ alerts | units in transit, failed scans only, damage reports, and the lots they belong to |
| HQ dashboard | still every synced case, tray and pack (needed for per-partner stock), but grouped by location once instead of once per partner; alerts from the same data instead of a second full read |
| My partners (SS/DB) | stock at its partners and what it sent them, by location |
| My stock | what is at this partner or on its way to it |
| Damaged, batch list/report, recall report, print-order codes, new print order, partner delete | only the rows involved (by status, batch, lot codes or partner) |

Response shapes, permissions, partner scoping, sync visibility, audit events and business rules are unchanged.

**Measured at 100,000 code records** (p95, one client → 10 clients, same PC):

| | Lookup | Dashboard | Alerts | My partners | My stock | Writes |
|---|---:|---:|---:|---:|---:|---:|
| PostgreSQL before | 677 ms → 23.7 s, 40 % errors | 11.8 s → all timed out | 1,148 ms | 1,385 ms | 887 ms | 20–167 ms |
| **PostgreSQL after** | **38 ms → 281 ms, 0 errors** | **1,641 ms** → 11.0 s | **111 ms** | **147 ms** | **74 ms** | 17–202 ms |
| JSON before | 4,168 ms | 10.0 s → all timed out | 908 ms | 1,489 ms | 1,273 ms | 2.7–2.9 s |
| JSON after | 2,751 ms | 1,350 ms → 11.8 s | 194 ms | 157 ms | 79 ms | 3.1 s |

**Verdict:** 100,000-record support is **not proven**. On PostgreSQL the lookup, filtered lists, partner hierarchy and
writes meet the sequential targets; the **dashboard does not** (needs counts in the database), and most 10-client
targets miss on this 8 GB PC (client, app and database share it). The JSON store cannot meet the lookup and write
targets at this size by design (it rewrites the whole file on every write, including every lookup's audit scan).

**Tests added:** `tests/unit/scalability.test.ts` (20 tests on the JSON store and on PostgreSQL: each changed screen is
compared field by field with the old whole-table computation, and every read is recorded to prove no whole table is
loaded; access rules, unsynced codes, empty network, concurrent lookups) and one store-contract test for the list
filter. All unit tests, lint, typecheck, build and the 12-step browser demo pass.

**Open (proposals, not done):** dashboard and batch-list counts in the database; `LIMIT`/pages for the scan audit,
alerts and partner list (DEF-004); a partial index for in-transit units; make `perfGenerate.mjs` data valid on
PostgreSQL; run the PostgreSQL unit-test files one at a time (INFO-4); re-measure at 1M on separate machines.

## Deployment caveats

- Sign-in must be ON (`SIGN_IN=on`, the default for `npm start`) on any shared host; with it off anyone can act as anyone.
- Use PostgreSQL in production; the JSON store rewrites one file per write and holds everything in memory.
- Set `HTTPS_ONLY=1` behind HTTPS; phones need HTTPS for the camera.
- Rate limits are per server process (in memory); several processes need a shared limiter.
- Finish DEF-002 (dashboard counts in the database) and re-measure at 100k–1M+ on PostgreSQL, with a separate client
  machine, before a volume pilot.

## Next steps (ordered)

1. DEF-002 remainder: dashboard and batch-list counts in the database (Scalability report Part A, P1/P4), then
   benchmark on PostgreSQL at 1M. Review and commit the 28 Oct remediation first.
2. DEF-001 and DEF-003 (small; DEF-001 changes authorization, so approve first).
3. Decide INFO-1 (PIN/state validation) and the test-timeout change for PostgreSQL unit tests.
4. Load, soak and failure drills from the Testing plan on a dedicated machine.

---

# Change log

Add one entry per change, newest first: date, who, what changed, files, and how it was verified. Update the affected
section above in the same change.

| Date | Who | Change | Verified |
|---|---|---|---|
| 28 Oct 2026 | Claude Code on `develop/aditya` | **Partner registration end-to-end test through the real Partners UI** (no code or data change in the repo). On a fresh disposable data file in an isolated copy (sign-in ON) — not `data/db.json`, which the app on :3000 uses — all 18 Maharashtra sample partners (`tests/qa/maharashtraDataset.ts`) were registered through the form in hierarchy order: MF0001 (+ -OP, -QC), SS0001, SS0002 (Goa: one SS per state), DB0001–3 under SS0001, DB0004–5 under SS0002, RT0001–RT0010 two per distributor. Each new sign-in signed in with its QA password and was checked for portal, menu and refused pages/APIs. Findings: no defects. Notes: there is no stored Manufacturer → Super Stockist link (the plant may dispatch to any SS, verified); the success notice shows the new password in plain text for the Admin to share (by design); the Partners table's inline-edit inputs reuse the form's labels ("Contact person" …), so a page has two controls with the same accessible name. | 48/48 checks: 18 registrations (IDs, parents, fields, sign-ins, 1 POST each incl. a double click, listed after reload); duplicate phone refused with no partner or sign-in created; Maharashtra and Goa greyed out for a third SS; 19 sign-ins: portal, menu, 2 forbidden pages and admin/dashboard APIs (403), sign-out; 7 parents see exactly their children in My partners and Dispatch; plant dispatches to exactly SS0001, SS0002. Evidence (passwords masked, 0 password hits in logs): scratchpad `reg-evidence/` |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **Review of the UI smoothness pass.** One defect fixed: on phones the HQ dashboard skeleton lacked the Refresh row and the 2-line subtitle, so content jumped 76 px when data arrived; `LoadingPage` now takes the page's `actions` and wraps its subtitle placeholder like the real one (`ui.tsx`, `hq/page.tsx`). Everything else verified as reported; no other change. Pre-existing, not changed: a failed dashboard refresh replaces the page with the error notice; console 404 `/api/auth/dev-users` (DEF-003) and 401 `/api/auth/me` before sign-in. | Lint, typecheck pass; unit 249/249; build + e2e 12/12; browser on a copy of the QA data: layout shift on load 0 px at 1440/1366/768/390/360; refresh keeps data and clears busy after success and failure; failed password change sends 1 request on double-click and double-Enter, busy clears; page fade on path change only, shell not remounted, no hydration warnings; reduced motion: drawer, skeleton and fade static, focus trap holds |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **UI smoothness and feedback** (uncommitted; Part 3 "Shared components" and "Motion and accessibility" updated). Motion tokens and loading utilities (`globals.css`); `Skeleton`, `LoadingPage`, delayed `Loading`, error fade (`ui.tsx`); `useAction` double-submit guard (new `useAction.ts`) on settings, account, void, reprint, recall, pools, new sign-in, AdminCrud, plus spinners on dispatch, partner registration and QC confirm; `refreshing` in `useApi.ts`; HQ dashboard skeleton and busy Refresh (`hq/page.tsx`); route fade `PageFade.tsx` in `(screens)/layout.tsx`; mobile drawer focus trap (`Sidebar.tsx`). No API, permission, business-rule, data or dependency change. | Lint, typecheck pass; unit 249/249 (JSON project); build + e2e 12/12; browser on a copy of the QA data, before vs after: drawer Tab escapes 17 → 0, double-click Save sends 2 → 1 request, dashboard loads with skeleton instead of a blank page; 7 roles: same menus and titles, no horizontal overflow at 1440/1366/768/390/360 px, no new console errors; dark theme and reduced motion checked |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **DEF-002 scalability remediation** (uncommitted). Store filters accept "any of" lists (`Store.ts`, `jsonStore.ts`, `sql/sqlStore.ts`); HQ trace, alerts, dashboard, My stock, batch list/report, recall report (`trace.ts`), My partners (`movement.ts`), Damaged (`damage.ts`), print orders (`printOrders.ts`) and partner delete (`admin.ts`) read only the rows they need; dashboard and My partners group by location once; HQ lookup reads outside its audit transaction (fixes DEF-005, PostgreSQL serialization failures). No response, permission, audit or business-rule change; no schema change. Tests: `tests/unit/scalability.test.ts` (new), `store.contract.test.ts` (+1). Docs: Part 4 here, `docs/SCALABILITY_REPORT.md` Part A, `docs/QA_REPORT.md` §14, `docs/qa/def-002/`. | Lint, typecheck pass; unit 249/249 (JSON project) and 76/76 (PostgreSQL project, files one at a time); build + e2e 12/12; old-vs-new differential 104/105 identical (1 age label); benchmarks 1k/10k/100k on JSON and PostgreSQL 17.3 before and after. Dashboard at 100k still over target |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **End-to-end QA, test data and scalability audit (Part 4).** 18-partner Maharashtra dataset (`data/qa-mh-2026.json`, git-ignored); QA harness `tests/qa/` (live API, browser, perf generator and benchmark, QA server launcher); unit test `tests/unit/maharashtraDataset.test.ts`; reports `docs/QA_REPORT.md`, `docs/SCALABILITY_REPORT.md`, `docs/MANUAL_QA_GUIDE.md`, evidence `docs/qa/`. No application code changed. Found DEF-001 to DEF-004. | Lint, typecheck pass; e2e 12/12 and build (baseline, same app code); unit: JSON all pass, PostgreSQL files time out (environmental); live QA 87 PASS / 1 FAIL (DEF-001); browser QA 64 PASS; benchmarks 1k/10k/100k |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **Transparent favicon.** Added `velza-favicon.svg`: the V only, no background, black on light browser chrome and white on dark. `favicon.ico` (V on white) kept as fallback. Files: `src/components/brand-assets/velza-favicon.svg` (new), `src/app/layout.tsx`. | Typecheck, lint; page head lists both icons; SVG served `200 image/svg+xml` without a session |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **Left sidebar shell.** Navigation moved from the top bar to a collapsible left sidebar (drawer below 1024 px); compact header with *portal › page* context; Operator device status on a header sub-row. Files: `Sidebar.tsx` (new), `AppHeader.tsx`, `ActAs.tsx`, `DeviceBar.tsx`, `ScanInput.tsx`, `themeScript.ts`, `icons.tsx`, `globals.css`, `(screens)/layout.tsx`, `(screens)/page.tsx`. | Lint, typecheck, build, e2e 12/12; all 7 roles and 8 widths in a browser |
| 28 Oct 2026 | Claude Code on `develop/aditya` | **Polish pass.** Wider content (up to 1600 px), larger type and icons, roomier cards and tables, consistent select chevrons, header regrouped; fixed the theme fade ignoring reduced motion. | Lint, typecheck, build, e2e 12/12 |
| 27 Oct 2026 | Claude Code on `develop/aditya` | **Velza Global brand redesign.** Brand-book tokens, Open Sans, official logo artwork and favicon, light/dark/system themes, icon set, all 31 screens restyled. | Lint, typecheck, build, e2e 12/12 |
| 27 Oct 2026 | Abhay Velza | Working model written (Parts 1–2): Retailer chain (phase 16), scale assessment, Python backend plan, key notes. | — |
