# Velza Traceability — Working Model

Oct 27, 2026 · Abhay Velza · living document, updated 30 Oct 2026 (see [Change log](#change-log))

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
- **Part 5 — Sign-in activation (29 Oct 2026)** · [Sign-in activation](#part-5--sign-in-activation-29-oct-2026)
- **[Change log](#change-log)**

---

# Part 1 — Working model

## Overview

Velza Traceability gives every case, tray and pack of Velza beverages a unique code and records each hand-over from
the factory to the retailer. Stickers with a barcode are printed at the plant, checked by QC, and scanned
OUT and IN at every step of the chain. Since 6 Nov 2026 the plant ships only to the **Velza Warehouse**, in shipping
containers: **Manufacturer → Velza Warehouse → Super Stockist, Distributor or Retailer**, and from there the chain goes
on as before: **Super Stockist → Distributor → Retailer** (a few retailers are supplied by their Super Stockist directly).

Velza Global India runs the system through two central roles: **Velza Admin** sets up the network, and **Velza HQ**
watches it (status, location, history, alerts, recalls). Each of the 8 roles works in its own portal and sees only its
own part of the chain. Lot stickers no longer carry a QR code (6 Nov 2026); cases printed earlier with a QR still open
the public check page, where consumers see whether the product is genuine and not recalled.

The current build is a working prototype. Sign-in is built and was switched on on 29 Oct 2026; since 30 Oct 2026 it is
**temporarily off** on the development PC for testing (`SIGN_IN=off` in `.env.local`): the app opens straight on the
Velza Admin portal (see [Sign-in activation](#part-5--sign-in-activation-29-oct-2026), "Sign-in temporarily off"). PostgreSQL
support is built and waits for the database, and data lives in a file until then. The code is on GitHub (see
[Development and release](#development-and-release)). It is not yet ready for 2 crore stickers or for zero downtime at
the plant (see [Scale and readiness](#scale-and-readiness-2-crore-stickers)).

## Working model structure

The model has three parts: a five-tier partner chain, a code on every unit, and a status that moves with each scan.

### Partner tiers and assignment

Every Distributor is assigned to one Super Stockist. Every Retailer is assigned to one Distributor, or to its Super
Stockist directly. A partner sees, and can dispatch to, only the partners assigned to it — except the **Velza
Warehouse**, which is Velza's own and supplies any Super Stockist, Distributor or Retailer. The Supplier tier was removed
and Outlet renamed Retailer on 27 Oct 2026; the Velza Warehouse tier was added on 6 Nov 2026.

| Tier | Receives from | Dispatches to | Assigned to | Example |
|---|---|---|---|---|
| Manufacturer (plant) | — | Only the Velza Warehouse (in shipping containers, or case by case) | — | vietnam_plant |
| Velza Warehouse (VW) | Manufacturer | Any Super Stockist, Distributor or Retailer | — (not assigned) | VW0001 Bhiwandi |
| Super Stockist (SS) | Velza Warehouse | Its assigned distributors and its direct retailers | — | pune_stocks |
| Distributor (DB) | Velza Warehouse, or its Super Stockist | Its assigned retailers | One Super Stockist | fc_road_db, baner_db → pune_stocks |
| Retailer (RT) | Velza Warehouse, its Distributor, or its Super Stockist | — (sells to consumers) | One Distributor, or one Super Stockist directly | JW Marriot → fc_road_db; Colaba Kirana → pune_stocks |

Example: assign 50 distributors to the Pune SS, and the Pune SS sees exactly those 50 plus the retailers assigned to it
directly. Assign 50 retailers to fc_road_db, and fc_road_db sees exactly those 50. An SS never sees the retailers of its
distributors.

### Velza Warehouse and shipping containers (since 6 Nov 2026)

- There is one Velza Warehouse for now (VW0001, sign-in VW0001, role *Velza Warehouse*). Admin registers more on
  Partners like any other tier if the company opens more; nothing else changes. A warehouse is not assigned to anyone.
- Its portal: Receive, Containers, Dispatch, My stock, Damaged. Stock there has the status **At warehouse**. It never
  opens cases or trays (only Retailers do).
- **Containers.** The plant ships to the warehouse in shipping containers of up to **2,860 cases and trays**. On the
  operator's *Containers* page: open a container by its own number as printed on it (e.g. `MSCU1234567`; letters, digits
  and dashes, 3–20 characters, never a case/tray code) → scan cases and trays into it (each must be Packed by QC, synced,
  at the plant and in no other loading container; packs are refused; *Take out* removes one) → choose the warehouse and
  the invoice → **Dispatch container**: every case and tray in it is checked like a normal dispatch and they all go, or
  none do. A loading container can be cancelled.
- The warehouse receives a container by scanning its number on **Receive**: every case and tray in it still on its way
  there becomes At warehouse at once (one received movement each, noting the container). Ones already received singly
  are left as they are. Anyone else scanning the number gets WRONG_RECEIVER; scanning it again, DUPLICATE_RECEIPT.
- A container number is reused for many trips: it is unique only while that container is loading or on the road; once
  received, the next trip can use it again. Each trip is its own record (status Loading → On the way → Received, with
  invoice, times and who did it). The operator sees its plant's containers, the warehouse those sent to it, Velza HQ all
  of them (*Containers*). In a code's timeline the dispatch and receipt say "Container MSCU1234567".
- The plant can still dispatch single cases and trays to the warehouse on Dispatch (no container).

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
- Every sticker carries a Code 128 barcode only, no QR code. Lot (case and tray) stickers are 100 × 50 mm, pack stickers
  75 × 25 mm; the lot barcode is a little bigger than the pack one (bars up to 0.4 × 18 mm, about 80 × 18 mm in all,
  against about 0.3 × 14 mm and 67 × 14 mm on a pack).
- Cases and trays are printed separately, never in one run: they go on different label rolls and are stuck on
  differently. The print view has a **Print run** choice (Cases / Trays); each run shows and prints only its own
  stickers (each lot sticker followed by its packs) and is confirmed on its own with *Mark cases as printed* or
  *Mark trays as printed*. Both runs use the same sticker sizes.
- Cases and trays per batch are each **0 or a whole number, with no minimum** (an empty box counts as 0). A batch may
  even be 0 cases + 0 trays: it takes its batch code now and gets its lots later with *Continue an existing batch*.
  Only an order (or a continuation) with nothing to print at all is refused.
- Nobody types or edits a code; the system generates them all.
- A batch can be printed over several days: see [Continuing a batch](#continuing-a-batch).

### Continuing a batch

Added 30 Oct 2026. New print order → **Continue an existing batch** adds lots to a batch that already exists, carrying
on from where the last print order stopped. Day 1 prints lots `00001`–`02710` (10,000 lots); Day 2, on any online PC of
the same plant and by any operator, carries on at `02711`. The sequence never restarts because of a new day, a
sign-out, another operator, a refresh, a restart or another device.

**Counter scope (confirmed 30 Oct 2026; reconfirmed 6 Nov 2026).** One counter per batch. **One batch, one flavour:** a
batch is one flavour and one production run, so the counter is also per batch + flavour; it is never shared between
batches or flavours. Cases and trays share the batch's counter (cases first, then trays, in each order). Continuing a
batch always keeps its flavour; there is no flavour choice for an existing batch. For another flavour, create a new
batch. (From 5 to 6 Nov 2026 a continuation could switch flavour; that was removed. Lots printed that way keep their
flavour, and the screens still show each lot's own flavour, so such a batch lists e.g. "Original, Green Apple".)

**Lot numbers.** Five uppercase hex characters, fixed width, built only by `formatLotNumber` in `src/lib/core/codes.ts`.

| Decimal | Hex | | Decimal | Hex |
|---:|---|---|---:|---|
| 1 | `00001` | | 10,001 | `02711` |
| 100 | `00064` | | 20,000 | `04E20` |
| 1,000 | `003E8` | | 30,000 | `07530` |
| 10,000 | `02710` | | 99,999 | `1869F` (maximum) |

`00000` is reserved and never issued. After decimal 10,000 the next lot is `02711`, not `10001`. The batch's stored
counter is `nextLot` (the next unused number, in decimal; `next_lot` in PostgreSQL).

**Counter status (worked out from `nextLot`, never stored).**

| `nextLot` | Status | Last lot | Next lot | Remaining |
|---|---|---|---|---:|
| 1 (new batch) | Active | — | `00001` | 99,999 |
| 10,001 | Active | `02710` | `02711` | 89,999 |
| 99,999 | Active | `1869E` | `1869F` | 1 |
| 100,000 (`0x186A0`) | **Exhausted** | `1869F` | — | 0 |
| anything else (0, negative, fraction, above 100,000) | **Counter invalid** | — | — | 0 |

An exhausted batch never wraps round to `00001` and never gets a new batch code automatically. A new batch is made with
New batches, as before. A counter-invalid batch is shown and refused, never repaired automatically (on 30 Oct 2026
every batch in every data file was consistent: `nextLot` = highest lot number + 1, no gaps).

**What continuing keeps and what it records.**

- The batch keeps its code, country, flavour, **manufacture and expiry dates**, device, first print order, creator and
  creation time. Only its counter moves. Continued lots carry the batch's dates; for different dates, start a new batch.
- Flavour: always the batch's own; the *Cases & trays* step has no flavour picker. A request that names another flavour
  is refused (400 `FLAVOUR_CHANGE_NOT_ALLOWED`) and allocates nothing.
- The new print order, its lots and their `GENERATED` movements record the PC and operator that continued the batch.
  The movement note says "continues batch ABC123 from 02711".
- Lot and pack codes, pack suffixes (`61`–`64`, `41`–`46`), stickers, QC, reprint, void, dispatch and public lookup
  work exactly as for any other lot.

**Who can continue, and when (all checked on the server).**

| Check | Refused with |
|---|---|
| Plant Operator sign-in only | 401 / 403 |
| The PC belongs to the operator's plant | 400 `NO_DEVICE` |
| The PC is **online**: continuing needs the central counter, so offline PCs can't allocate their own numbers | 409 `DEVICE_OFFLINE` |
| The batch belongs to the operator's plant (another plant's batch looks like no batch) | 404 |
| The batch is synced (a batch made offline must be synced first) | 409 `BATCH_NOT_SYNCED` |
| Not recalled | 409 `BATCH_RECALLED` |
| Counter valid / not exhausted | 409 `BATCH_COUNTER_INVALID` / `BATCH_EXHAUSTED` |
| A flavour, if sent, is the batch's own (one batch, one flavour) | 400 `FLAVOUR_CHANGE_NOT_ALLOWED` |
| Cases and trays 0 or a whole number (either may be 0); 1 to 10,000 lots per order in all (**1,000 on the JSON file store**) | 400 `INVALID_QUANTITY` / `TOO_MANY_LOTS` |
| No more than the lots left in the batch | 409 `INSUFFICIENT_CAPACITY` |

Offline working for new batches, printing and verification is unchanged.

**How the number is allocated.** One store transaction does everything:

1. Check the request.
2. Reserve the range with the existing `nextLotNumber`, a single conditional
   `UPDATE batches SET next_lot = next_lot + n WHERE next_lot + n − 1 ≤ 0x1869F` in PostgreSQL (`SERIALIZABLE`), or the
   file lock in the JSON store.
3. Build the codes with the existing `allocateLots`.
4. Write the lots, packs, print order and movements.

If anything fails, the whole transaction rolls back, counter included, so a failed or interrupted request never uses
up numbers. Two operators at once get adjacent ranges that never overlap: PostgreSQL makes the second wait for the
batch row (or retries it), and the JSON store runs one transaction at a time. Lot codes are primary keys, which is a
last guard against duplicates.

**Retried requests (idempotency).** The wizard sends a request key (a UUID) with Create & print. The server uses it as
the new print order's ID, so the key is stored in the same transaction as the lots and survives restarts.

- Sending the same key again with the same plant, batch, cases, trays and PC returns the stored order ("replayed")
  without allocating anything. This also works after the batch has filled up.
- The same key with a different batch, quantity or PC, or a key belonging to another plant, gets 409
  `IDEMPOTENCY_KEY_CONFLICT`, which reveals nothing about the stored order.
- If two same-key requests race on PostgreSQL, the loser either retries (serialization failure) and replays, or hits
  the order's primary key (unique violation), re-reads the order and replays.
- If PostgreSQL serialization retries run out, the request gets 409 `ALLOCATION_BUSY`; nothing was saved, so pressing
  Create again (same key) is safe.
- The wizard makes a new key whenever the batch, cases or trays change.
- New-batch orders are not idempotent (unchanged).

**Preview versus result.** The Summary step is read-only and never touches the counter. It shows the *expected* range.
The Print step shows the range the server actually allocated. If another order took numbers in between, the Print step
says so, for example "your lots start at 0271A instead of the expected 02711".

**JSON file store limit.** The JSON store rewrites the whole `db.json` on every transaction (about 2.75 KB per lot
including packs and movements: 5,000 lots ≈ 13.7 MB). It is for development and small tests only. Continuation orders
are capped at 1,000 lots there, and **it is not suitable for allocating up to 99,999 lots per batch: production must
use PostgreSQL** (10,000 lots per continuation order). The existing New batches flow still allows up to 99,999 lots per
batch on either store (unchanged).

**API.**

| Request | Answer |
|---|---|
| `GET /api/print-orders/continue` | `{ maxLotsPerOrder, batches: [{ batchCode, country, flavour, flavourName, mfgDate, expiryDate, createdAt, status, counter, continuable, blockedReason }] }` for the operator's plant |
| `POST /api/print-orders/continue` `{ batchCode, cases, trays, deviceId?, preview: true }` | `{ ok, problem, batch, device, totalLots, stickerCount, expectedFirstLotHex, expectedLastLotHex, remainingAfter, maxLotsPerOrder }`, read-only |
| `POST /api/print-orders/continue` `{ batchCode, cases, trays, deviceId?, idempotencyKey }` | `{ replayed, printOrder, batchCode, firstLotHex, lastLotHex, totalLots, stickerCount, counter }` |

`GET /api/batches` and the batch report also return `counter` and `displayStatus` (Active, Exhausted, Counter invalid,
Recalled); the Batches page shows the Exhausted badge and lots left.

**Known limitations.**

- A 10,000-lot order took about 14 s to create on embedded PostgreSQL (PGlite) in tests: 50,000–70,000 rows plus one
  movement per lot. Marking it printed loops over every lot, and the print view renders 50,000–70,000 stickers in the
  browser. All of this is existing behaviour, not changed here, and has not been measured on a hosted PostgreSQL server.
- The tests run PostgreSQL embedded (one connection), so real multi-connection contention is covered by injecting the
  PostgreSQL errors (unique violation, serialization failure) rather than by a live server.
- The operator screens use the plant's first registered PC (as before); the API accepts another of the plant's PCs as
  `deviceId`, but there is no PC picker.

### Serial integrity and duplicate-print protection

Added 4 Nov 2026 after the serial-uniqueness audit (P0–P2). A lot code is allocated once, and its sticker is printed
from the system once, plus logged reprints. This is enforced on the server and in storage, not by the screens.

- **Idempotent orders.** Both `POST /api/print-orders` (new batch) and `/api/print-orders/continue` need an
  `idempotencyKey` (UUID). It becomes the order id, and the order stores its `kind` (`NEW_BATCH` / `CONTINUATION`)
  and a SHA-256 `requestFingerprint` of the request (manufacturer, PC, batches or batch + cases + trays). The same key
  with the same request returns the stored order (`replayed: true`, nothing allocated); the same key with anything
  else is `409 IDEMPOTENCY_KEY_CONFLICT`. A continuation never replays a new-batch order. Orders made before 4 Nov
  have no kind; an old continuation still replays by the old structural check, an old new-batch order never does.
  The New print order screen keeps one key per exact request across retries.
- **Allocation lock.** On PostgreSQL, the print-order transactions of one manufacturer take a session advisory lock
  before `BEGIN` (`Store.transaction(fn, { lockKey })`, `src/lib/store/sql/driver.ts`). Concurrent orders, also from
  several app processes, wait their turn with a fresh snapshot instead of failing. Waiting is capped at 30 s
  (`VELZA_ALLOCATION_LOCK_WAIT_MS`); expected contention answers 409 `ALLOCATION_BUSY`, never a raw 500. All
  queries of a transaction run one after another (`sequential` in the driver).
- **Storage guards (both stores).** A batch's `nextLot` can never decrease, and a code issued by a print order can
  never be deleted or renamed (`IntegrityError` `COUNTER_BACKWARDS` / `ISSUED_CODE_PROTECTED`, API 409). On PostgreSQL
  these are triggers (schema v3); a reset's `TRUNCATE` still works.
- **Sticker sheets.** `GET /api/print-orders/<id>` serves stickers only while the order is CREATED, and only lots still
  GENERATED (voided or recalled lots are withheld). Each serving is logged (`PRINT_SHEET_SERVED`, item = the order).
  Once the order is PRINTED, the request is `409 ORDER_ALREADY_PRINTED`; the print view hides **Print** after
  **Mark as printed** and the order list offers Reprint instead.
- **Reprints.** `POST /api/reprint` logs the authorization: code, reason, sign-in, time, PC and the order that
  issued the code (`printOrderId`). Its sticker is served once by `POST /api/reprint/<id>/stickers`, recorded as
  `REPRINT_SERVED` with the fixed row id `reprint-served:<id>`; that id is unique in storage, so a second use is
  refused (`409 REPRINT_ALREADY_USED`), also between concurrent requests. A code that became VOID, RECALLED or left the
  factory after it was logged is refused. The old `GET /api/stickers?code=` answers `410 REPRINT_REQUIRED`, and
  `/print/code/<code>` points to Reprint. The Reprint log shows when each reprint was printed.
- **JSON file store: one process.** On first use the process creates `<file>.lock` (pid, host, time, token)
  exclusively and removes it when it exits. Another process gets `JsonStoreLockedError` (API 503 `STORE_LOCKED`); a
  lock left by a process that no longer exists on this host is taken over. A transaction is also refused
  (`ConcurrentWriteError`, nothing saved) if the file changed on disk after it was read. Stop the server before
  running a script (seed, import, clear-activity) on the same file. The JSON store is for single-process trials;
  production must use PostgreSQL.
- **Limits.** The server can't see the printer. "Mark as printed" is the operator's confirmation, a print dialog can
  print several copies, and a printer's copy function or a photocopier can't be controlled. The codes list and CSV
  (`/api/print-orders/<id>/codes`) still show every code, so they could be fed to label software outside the system.

### Statuses

A case or tray moves as one sealed unit until it is opened; after that, its packs move one by one. An opened case or
tray still counts as a case or tray at the location that opened it (in My stock and on the HQ dashboard) while any of
its packs is still there.

| Status | Meaning | Set when |
|---|---|---|
| Generated | Codes allocated, stickers not printed | Operator creates a print order |
| Printed | Stickers printed | Operator confirms each print run (cases, trays) with **Mark cases as printed** / **Mark trays as printed** in the print view; only that run's lots become Printed, so QC can start on the cases while the trays are still printing. **Print** only opens the browser print dialog; cancelling or closing it, Ctrl+P, downloading the codes CSV or leaving the page record nothing. The print order shows *Printing pending* until every run is confirmed, and QC refuses lots of an unconfirmed run. An order whose lots are all voided cannot be marked printed |
| Packed | QC checked the lot and all its pack stickers | Supervisor/QC confirms |
| In transit | On its way to the next partner | Sender confirms dispatch (or the operator dispatches its container) |
| At warehouse / At SS / At DB / At Retailer | Received at that partner | Receiver scans it IN (the warehouse can scan a whole container's number) |
| Opened | Case or tray opened; packs now move individually | Retailer opens the lot (only Retailers open cases and trays) |
| Quarantined | Failed QC check; cannot move. Two ways out: Void (ends as Void for good), or reprint the bad sticker with a reason, which sends the lot back to Printed so QC verifies it again before it becomes Packed | QC confirms with missing or wrong packs |
| Void | Misprinted or unused stickers cancelled | Operator voids the lot |
| Damaged | Case, tray or pack damaged; leaves stock, cannot move, HQ alerted, public page says not for sale | Plant, Velza Warehouse, SS, DB or Retailer reports it on its Damaged page, with a reason, a photo of the item showing its barcode and 1–4 photos of the damage itself |
| Recalled | Batch withdrawn; cannot move, public page warns consumers | Velza HQ recalls the batch |
| Return in transit | Taken back from an SS, DB or Retailer; on its way to the Velza Warehouse; only that warehouse can receive it; public page says withdrawn | Velza field staff press **Take back** (since 13 Nov 2026) |
| Returned | Back at the Velza Warehouse, waiting for its inspection; cannot move | The warehouse scans the return IN |
| Expired | Written off at the warehouse as past its expiry date; never dispatched again; public page says expired | Warehouse inspection: **Write off: Expired** (Write off: Damaged sets Damaged) |

## Tree diagrams

### Partner tree

Velza Admin builds the tree and Velza HQ sees all of it. The Pune SS sees only its 50 distributors and the retailers
assigned to it directly; each distributor sees only its own retailers.

```
Velza Admin (builds)            Velza HQ (sees everything)
        │
Manufacturer (vietnam_plant) ──► only the Velza Warehouse (containers)
        │
Velza Warehouse (VW0001) ──► any Super Stockist, Distributor or Retailer
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
Plant: Container (scan cases/trays in) ─► Dispatch container (invoice) ─► In transit ─► VW: scan container number ─► At warehouse
VW: Dispatch ─► In transit ─► SS, DB or Retailer: Receive ─► At SS / At DB / At Retailer
SS: Dispatch ─► In transit ─► DB: Receive ─► At DB ─► Dispatch ─► Retailer: Receive ─► At Retailer ─► Open lot ─► Opened
SS: Dispatch ─► its direct Retailer ─► At Retailer
Any stock-holding tier: Damaged (reason + photo with barcode + 1–4 damage photos) ─► Damaged, HQ alerted
Velza HQ: Recall batch ─► Recalled everywhere; any later scan ─► BLOCKED_CODE alert
```

## Connection establishment

A new partner is connected in five Admin steps, and from then on every location connects through a browser and a
scanner, camera or keyboard.

### Onboarding a partner (Velza Admin)

1. **Partners → Register a partner:** tier, site name, contact person, place, address, city, state, PIN, phone and email.
   The system issues the next ID of the tier (MF0001, VW0001, SS0001, DB0001, RT0001 …) and a sign-in with that ID; Admin shares
   the password.
2. **Assigned to:** link it to its parent in the same form. A distributor goes under a Super Stockist. A retailer goes
   under a distributor, or, by choosing Super Stockist in *Assigned to tier*, directly under its Super Stockist. Without
   this link, nobody can send it stock.
3. **Sign-ins & passwords:** each partner's sign-in is made with it (the plant gets MF0001-OP and MF0001-QC). Add Velza
   staff sign-ins (AD…, HQ…) or reset a forgotten password here.
4. **Devices (plants only):** register the plant PC. It immediately receives 10 batch codes and is topped up automatically.
5. **Settings (once):** sticker sizes, the public web address of the check page (opened by QR codes on older stickers), and the alert threshold (default: not
   received within 3 days).

Each later hand-over then connects two partners on its own: the sender scans OUT with an invoice or challan number, and
only the assigned receiver can scan it IN. Anyone else who scans it gets a WRONG_RECEIVER alert at HQ.

### How each location connects

| Location | Device | Scanning | Volume |
|---|---|---|---|
| Manufacturer | Plant PC (registered device) | Webcam or phone camera now; a 2D USB scanner at the QC table is recommended | Highest: QC scans every lot and pack sticker |
| Velza Warehouse | PC with a barcode scanner | Container number once per container; case/tray barcodes when dispatching onward | High: whole containers in, whole cases out |
| Super Stockist | Phone or PC | Phone camera on the lot barcode | Low: whole cases only |
| Distributor | PC, tablet or phone | Barcode scanner (USB or Bluetooth, keyboard mode) | Medium: whole cases only |
| Retailer | PC, tablet or phone | Barcode scanner | Medium; the only tier that opens cases into packs |
| Consumer | Own phone | Phone camera on the QR code of older stickers; opens the public check page (new stickers have no QR) | — |

- Scanners act as a keyboard: they type the code and press Enter into the scan box, so no driver or setup is needed.
  Every scan screen also has **Use camera** and accepts typed codes.
- Network: the app runs in a browser. Phone cameras need an HTTPS address, which the production server will provide.

#### Scanning (updated 4 Nov 2026, branch `feature/barcode-scanner`)

One scan box on every scan screen (`src/components/ScanInput.tsx`), three ways in, all ending in the screen's
existing API (no new API, no second audit log; every scan, accepted or refused, is in the scan audit as before):

| Way in | How it behaves |
|---|---|
| USB / Bluetooth scanner (keyboard mode) | Types the code + Enter into the box. Only Enter (or **Scan**) sends; a half-typed value is never sent. Prefix/suffix characters some scanners add (Tab, GS, CR/LF) are removed; lower case is upper-cased; nothing inside the code is changed (leading zeros kept). Codes scanned faster than the server answers are queued in order (no scan lost, an identical waiting code is not sent twice). The box takes the focus back after each scan on PCs. |
| Manual entry | Type and press Enter or **Scan**. The format is checked first: 15 characters = case/tray, 17 = pack; anything else is explained and not sent. |
| Camera (phone or webcam) | **Use camera** → preview with an aiming frame, **Stop/Start camera**, camera choice when there are several (rear camera by default), **Torch** where the phone supports it. Code 128 (packs, lots) and QR (lots; the URL is reduced to the code). The same sticker held in view is sent once (2.5 s window); nothing is sent while the previous scan is being checked. The camera is released on Stop, Close, leaving the page and when the tab is hidden. Needs **https://** (or localhost); clear messages for refused permission, no camera, camera busy, insecure page. |

**Live checklist** (`src/components/ScanChecklist.tsx`, logic in `src/lib/scan/checklist.ts`) under the scanner:
counters (Expected, Scanned, Pending, Invalid/rejected), progress %, and one row per expected code with its status —
**PENDING** (not scanned), **SCANNED** (the server accepted it), **INVALID** (refused: unknown/malformed code, pack of
another lot …), **DUPLICATE** (scanned again; an earlier SCANNED is never undone), **BLOCKED** (refused by a business
rule: recalled/quarantined/void, not printed, wrong receiver, wrong place or status). A row changes only from the
server's answer. Refused codes that are not on the list are listed separately. Lists over 10 rows get All / Scanned /
Pending / Invalid filters and a code search; 50 rows per page. Reaching 100% only shows a message: the screen's own
final action (Confirm → PACKED, Confirm dispatch) is still the person's decision.

| Screen | Expected list (from the server) | Sequence |
|---|---|---|
| QC Verify | The scanned lot's packs | Scan the lot → its 4 (case) or 6 (tray) packs appear PENDING → scan each pack (each checked by the server) → **Confirm → PACKED** unlocks at 100%; a missing or wrong pack keeps it locked — quarantine with a reason as before. Scanning the lot never ticks its packs. |
| Dispatch | Stock here that can be dispatched (synced, here, at this tier's status) | Destination + invoice → scan units (server check, nothing moves) → ticked rows form the dispatch; **Remove** puts a row back to PENDING → **Confirm dispatch**. |
| Receive | Everything in transit to you, with the invoice it was dispatched on (new `invoice` field on incoming items) | Each scan is received by the server immediately (unchanged); received rows stay ticked while on the page; search by invoice to work through one delivery. |
| Open lot | — | Unchanged: one scan opens the case/tray and lists its packs. |

QC pack progress and the dispatch list live in the open screen only (the server records the final confirm), so a
page reload starts that lot or list again; receipts are on the server immediately. Not offline: every scan needs the
server.
- Sign-in: a production build (`npm start`) always requires sign-in. Under `npm run dev`, `SIGN_IN=on` (in
  `.env.local`, git-ignored) asks everyone for their ID and password; with `SIGN_IN=off` (or unset) there is no sign-in: the app opens on the Velza
  Admin portal and the header's Role/User selects switch to anyone. This is the setting on the development PC since
  30 Oct 2026, for testing only. Anyone who can reach the app is then Velza Admin, so it must stay on this PC or a
  private network. `next dev` listens on every network interface by default; use `npx next dev -H 127.0.0.1` to keep it
  on this PC only.

### Working offline at the plant

- The plant PC can be switched **Offline** and keep printing and verifying, using the batch codes it already holds.
- Offline lots are invisible to everyone else and cannot be dispatched until the PC is back **Online** and presses **Sync**.
- Pool refills happen only while the PC is online.
- Today this offline mode is a switch on the plant PC record, not a real offline app: if the internet or the server
  goes down, the plant's screens stop. See [Scale and readiness](#scale-and-readiness-2-crore-stickers) for the on-site
  plant server that fixes this.

## Roles and responsibilities

There are nine roles: three central roles at Velza Global India (Admin, HQ, Field Staff, since 13 Nov 2026) and six in the distribution line. Each role sees only
its own portal, the server refuses anything outside it, and everyone can change their own password on the Account page.

| Role | Belongs to | Responsible for | Portal screens |
|---|---|---|---|
| Velza Admin | Velza Global India | Setting up and maintaining the network: registering partners (with their IDs and sign-ins), assignments, passwords, plant devices, country and flavour codes, batch code pools, settings. Deactivates or deletes records that have no history. | Partners (registration form), Sign-ins & passwords, Devices, Countries & flavours, Batch code pools, Settings |
| Velza HQ | Velza Global India | Watching the whole chain: stock and status everywhere, investigating alerts (not received, wrong receiver, unknown or blocked codes), tracing any code, following containers, recalling a batch. Only role with the HQ dashboard. | Dashboard, Search code, Alerts, Batches & recall, Containers, Scan audit |
| Velza Field Staff (VF0001…, since 13 Nov 2026) | Velza Global India | Visiting partners: scanning any code to see its full chain, holder, status and dates (view only — scanning never receives anything), and taking stock back to the Velza Warehouse (Take back). | Scan |
| Manufacturer Operator | A plant | Creating print orders and printing stickers, seeing every generated code per order, loading packed cases and trays into shipping containers and dispatching them to the Velza Warehouse with an invoice, reprinting damaged stickers (same code, reason logged), voiding misprints, keeping the plant PC synced. | New print order, Print orders (with Codes view), Containers, Dispatch, Reprint, Void lot, My stock, Damaged |
| Supervisor / QC | A plant | Checking that every pasted pack sticker belongs to its lot before anything leaves the plant: confirms to Packed, or the lot is quarantined. | Verify, My stock, Product details |
| Velza Warehouse | Velza Global India (one warehouse for now) | Receiving containers from the plant (one scan of the container number) and dispatching cases and trays to any Super Stockist, Distributor or Retailer. Never opens cases. | Receive, Containers, Dispatch, My stock, Product details, Damaged |
| Super Stockist | Its own company (one per state) | Receiving cases from the Velza Warehouse and dispatching them to its assigned distributors and to the retailers assigned to it directly. | Receive, Dispatch, My stock, Product details, Damaged, My partners |
| Distributor | Its own company | Receiving from the Velza Warehouse or its Super Stockist and dispatching to its assigned retailers. | Receive, Dispatch, My stock, Product details, Damaged, My retailers |
| Retailer | Its own shop | Receiving from the Velza Warehouse, its distributor or its Super Stockist and opening cases and trays for sale; the only role that opens them. Cannot dispatch. | Receive, Open lot, My stock, Product details, Damaged |
| Consumer (no login) | — | Scanning the QR code on older stickers to check a product is genuine and not recalled (new stickers have no QR). Sees no business data. | Public check page |

**Returns — Velza field staff (since 13 Nov 2026, branch `features/barcode-history`).** A new Velza staff role,
*Velza Field Staff* (`VELZA_FIELD`, sign-ins VF0001… made by Admin on Sign-ins & passwords), visits partners. Its only
screen is **Scan**: scanning is **view only** (it never receives) and shows the info card that Velza HQ and Admin also
get on *Product details*: the **full chain** plant → Velza Warehouse → SS → DB → Retailer, each step with the partner,
date **and time** and invoice (take-backs shown as *Return → Velza Warehouse*), the current holder, current status,
Mfg. date, Expiry date and days to expiry. **Take back** (field staff only, when the item is in stock at an SS, DB or
Retailer): reason *Not selling / Near expiry / Damaged / Other* (Other needs a note) → status **Return in transit** to
the Velza Warehouse, with a `RETURN_PICKUP` movement (user, partner it came from, reason, time). A single pack taken
from a sealed case or tray first **opens** that case or tray at the partner (an `OPENED` movement by the field staff);
its other packs stay in the partner's stock one by one. An opened case or tray is taken back pack by pack. While on its
way, nobody else can receive it (WRONG_RECEIVER) and the partner can't sell, open, dispatch or report it. The
**warehouse** scans it on Receive → **Returned** automatically; the *Returns to inspect* card on Receive then offers
**Back to stock** (At warehouse, can be dispatched again; `RETURN_RESTOCKED`) or **Write off: Damaged / Expired**
(never dispatched again; `RETURN_WRITTEN_OFF`). The **HQ dashboard** has a **Returns** report: code, item, flavour,
batch, expiry, returned from (partner + tier), reason, picked up by, date, final decision. PostgreSQL schema v6 (role
`VELZA_FIELD`, sign-in prefix VF, statuses `RETURN_IN_TRANSIT` and `EXPIRED`). Files: `src/lib/services/returns.ts`,
`src/app/api/returns/*`, `src/lib/services/details.ts` (full view), `src/app/(screens)/details/page.tsx` (info card,
Take back), `src/app/(screens)/receive/page.tsx` (inspection), `src/app/(screens)/hq/page.tsx` (report).

**Product details (since 13 Nov 2026, branch `features/barcode-history`).** Every level from the plant to the Retailer
(Operator, QC, Velza Warehouse, Super Stockist, Distributor, Retailer) has a *Product details* page: scan or type a case,
tray or pack code and it shows the flavour, **Batch No.**, **Mfg. date**, **Expiry date** (with the days left, or
"Expired"), pack *n of m* and the case or tray it came from, where it is now, and the **supply chain to you**: the plant,
then each partner it was received at, in order, with the date and invoice, ending with you. At a **Retailer** a
"Came to you from" card names the **Super Stockist and Distributor** (and the Velza Warehouse) it came through; a
retailer supplied by its Super Stockist directly sees "no Distributor". A recalled batch or an expired product shows a
"do not sell" warning. Disclosure: a partner sees only codes that are at its location, on their way to it, or have
passed through it (the plant: its own codes); any other code is answered exactly like an unknown code. The chain stops
at the viewer — where the stock went after leaving you is never shown, and the status is shown only while it is here
or on its way to / from you ("Passed through you" otherwise). Each scan is in the scan audit as `LOOKUP` (no alert).
API: `GET /api/details/<code>` (permission `details`); service `src/lib/services/details.ts`; page `/details`.

Every role that holds stock (plant, Velza Warehouse, Super Stockist, Distributor, Retailer) also reports damaged cases, trays and packs
on its Damaged page. Scanning the lot code reports a whole case or tray, opened or not (an opened one takes the packs of
it still at that location); single packs can be reported once the lot is opened. Each Damaged page and the HQ dashboard
show the count as cases, trays and single packs.

**Photo with the barcode (since 5 Nov 2026).** Every damage report needs one photo of the damaged item in which its
barcode or QR sticker can be read, plus at least one and at most 4 photos of the damage itself (close-ups of the dent,
leak or tear, other sides; no barcode needed). The page works in five steps: reason → scan the item → take or choose the barcode
photo → photos of the damage (added several at a time, each removable; at least one) → Report damaged. In the browser the barcode/QR in the photo is read (ZXing, as the camera scanner) and must be the
scanned code — a QR's public lookup URL counts as its code; a pack's code is not its case's. The button stays disabled
until it matches. The server checks again: a photo is required (`PHOTO_REQUIRED`), it must really be a JPEG, PNG or
WebP of at most 2 MB (`PHOTO_INVALID`, `PHOTO_TOO_LARGE`; the page shrinks photos to 1600 px JPEG first), and the code
read from it must be the reported code (`PHOTO_NO_BARCODE`, `PHOTO_BARCODE_MISMATCH`). Who may report is checked before
the photo. Limitation: the server does not decode the image itself — it trusts the code the page read from it, and
checks it matches. Photos of the damage: at least 1 (`DAMAGE_PHOTO_REQUIRED`), at most 4 (`TOO_MANY_PHOTOS`), each a real JPEG/PNG/WebP of at most 1 MB
(`PHOTO_INVALID` / `PHOTO_TOO_LARGE`, naming which photo; the page shrinks them to 1280 px JPEG first).

Storage: a file, not a table — `<upload dir>/damage/<report id>.jpg` for the barcode photo and
`<report id>.<n>.jpg` for damage photo n (1–4), where the report id is the `DAMAGED` movement's
id, written as the last step of the report's transaction (if any photo can't be written, those already written are removed
and the report is not saved). Upload dir:
`VELZA_UPLOAD_DIR`, else `uploads/` next to the JSON data file, else `data/uploads` (git-ignored). Back it up with the
data. The photos (`GET /api/damaged/photo/<report id>`, damage photo n: `?n=<n>`) are shown on the reporter's Damaged
page and on the HQ Alerts row, the barcode photo first; only the reporting partner and Velza HQ can open them (others
get 404). Reports made before this change have no photo.

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
| A lot whose print order was never marked printed is scanned at QC | Refused (not printed): the operator finishes printing from Print orders, or uses Mark as printed there |
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
| 1 | Sign-in | Switched on 29 Oct 2026 and verified for all 21 sign-ins and 7 roles (Part 5); **temporarily off since 30 Oct 2026** on the development PC for testing (`SIGN_IN=off`: opens on the Admin portal). Set `SIGN_IN=on` to require passwords again. Everyone signs in with their partner ID and the password Velza Admin shared, and can change only their own password. | Approve the fix for sessions started while sign-in was off staying valid after it is switched on (AUTH-1, Part 5). Optional extras: force a password change at first sign-in; two-factor sign-in for Velza Admin and HQ. | Decided (on) |
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
| Auth | Session cookie `velza_session` (HttpOnly, SameSite=Lax, 12 h), scrypt password hashes, lock for 5 min after 5 wrong passwords; `SIGN_IN=on/off` (off by default under `npm run dev`; while off, no session = the default Velza Admin) |
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

- Sign-in must be ON (`SIGN_IN=on`, the default for `npm start`) on any shared host; with it off anyone who opens the
  app is Velza Admin and can act as anyone. `npm start` also reads `.env.local`, so never copy a `.env.local` with
  `SIGN_IN=off` to a server; set `SIGN_IN=on` explicitly in the server's environment.
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

# Part 5 — Sign-in activation (29 Oct 2026)

Sign-in with passwords is switched on for the development PC. **No application code changed**: the sign-in code was
complete and active; it was off only because `SIGN_IN` was unset, which means off under `npm run dev`
(`src/lib/signInMode.ts`). No sign-in code was commented out. Manual test steps: [docs/MANUAL_SIGN_IN_TEST_GUIDE.md](docs/MANUAL_SIGN_IN_TEST_GUIDE.md).

## Configuration (development PC)

| Item | Value |
|---|---|
| Switch | `.env.local` (new, git-ignored) contains only `SIGN_IN=on`. A running `next dev` picks it up without a restart |
| Back to picking a person | Set `SIGN_IN=off` in `.env.local` (or delete the line) |
| Data | `data/db.json` (JSON store); no `DATABASE_URL` |
| Cookie | `velza_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 12 h; `Secure` only when the request is HTTPS (or `x-forwarded-proto: https`) |
| Network | `next dev` listens on all interfaces by default; `npx next dev -H 127.0.0.1` keeps it on this PC |

## Data change

`data/db.json` had only AD0001 and HQ0001 (no partners). The 18 QA partners and their 19 sign-ins were merged in from
`data/qa-mh-2026.json` after a verified backup (`data/db.backup-2026-10-29-before-auth.json`, git-ignored): only
missing records were added, the source was validated (parents, sign-in → partner links, hash format, no phone/e-mail or
one-SS-per-state conflicts), AD0001/HQ0001 kept byte-identical (their passwords are the ones from `npm run seed`),
ID sequences raised to the highest merged ID (MF 1, SS 2, DB 5, RT 10). Countries, flavours, settings and the 6 earlier
scan records unchanged; no devices, batches or stock were copied. The 8 sessions started while sign-in was off were
removed (see AUTH-1). Result: 18 partners, 21 sign-ins (Admin 1, HQ 1, Operator 1, QC 1, SS 2, DB 5, Retailer 10).

### Partners (0) after a re-seed — restored 29 Oct 2026

**Symptom.** Admin and HQ could sign in, but Admin → Partners showed `Partners (0)` · "Nothing yet".

**Cause.** `data/db.json` had been reset to a clean start at 12:02:42 IST (06:32:42 UTC), after the merge above. The
file matched `npm run seed` output exactly: 0 partners, only AD0001/HQ0001 with new password hashes and
`createdAt` = that time, a new country record ID, sequences only AD/HQ, no scans. The only code that writes this is
`npm run seed` (`scripts/seed.ts`) or the first-run seed for a *missing* file (`firstRunSeed`); the app replaces the
file by atomic rename, so it never leaves it missing — so the store was re-seeded, most likely by running
`npm run seed` to get new Admin/HQ passwords. The page, API and permissions were correct: `/api/admin/partners`
(used by `AdminCrud`) returned what the store held. No second server, other folder or other data source was
involved: one `next dev` on :3000 (this folder), JSON store, no `DATABASE_URL`, `.env.local` = `SIGN_IN=on` only.

**Fix (data only, no code change).** Backed up the re-seeded file (`data/db.backup-2026-10-29-after-reseed.json`),
then added the 18 partners and 19 partner sign-ins again from `data/qa-mh-2026.json` with the same validated,
duplicate-safe merge. The **new** AD0001/HQ0001 records (the passwords from the re-seed), the open session,
countries, flavours and settings were kept unchanged. Partners 0 → 18, sign-ins 2 → 21. The 6–7 earlier scan records
were wiped by the re-seed and not restored (they were test lookups).

**Verified on the real app (:3000):** the 19 partner sign-ins — sign-in, identity, the 18-API permission matrix,
hierarchy scope, logout — 579/580 (the miss is DEF-001); test sessions signed out afterwards, no scan written.
Admin/HQ through the same services on a copy of the live data: Admin lists 18 partners and 21 sign-ins (no hashes),
HQ gets the dashboard and is refused the Admin lists, Admin is refused the HQ dashboard. Admin/HQ **sign-in in the
browser not verified by Claude** (their new passwords are only known to whoever ran the seed).

**Don't re-seed to recover a password** — `npm run seed` wipes all partners, sign-ins and history. Use the recovery
in `docs/MANUAL_SIGN_IN_TEST_GUIDE.md` §0 instead. Backups: `data/db.backup-2026-10-29-before-auth.json` (before
the first merge) and `data/db.backup-2026-10-29-after-reseed.json` (the re-seeded state); both git-ignored, contain
password hashes — don't share them.

## Sign-in temporarily off (30 Oct 2026)

> **Warning:** `SIGN_IN=off` is for local development and testing only. Never use it on a server or any deployment
> other people can reach: everyone who opens the app is Velza Admin.

**Why.** For local development and testing, the app should open straight on the Velza Admin portal without the
sign-in page. The sign-in code (passwords, sessions, lockout, login/logout routes, roles, permission checks) is
unchanged and comes back with one setting.

**Configuration.** `.env.local` (git-ignored) contains `SIGN_IN=off`. A running `next dev` picks it up without a
restart. Open http://localhost:3000: the Velza Admin portal Overview appears.

**Behaviour while off** (3 small code changes, all inactive while sign-in is on):

| What | Where |
|---|---|
| Every page opens without a session cookie; `/login` redirects (307) to `/`, the existing Admin Overview | `src/proxy.ts` |
| An API request without a valid session acts as the **default Velza Admin**: the first active `ADMIN` sign-in (AD0001). No session is created and nothing is written to the data | `devDefaultUserId()` in `src/lib/services/auth.ts`, used by `handler()` in `src/lib/api.ts` |
| The header's existing Role/User selects (the visible sign that sign-in is off) still switch to any person; that starts a normal 12 h session as that person | unchanged (`ActAs.tsx`) |

**Development identity: limits.** It is the real AD0001 record, not a separate account, so anything changed through
the Admin pages while sign-in is off is recorded as AD0001. Role checks stay on: the Admin is refused HQ and partner
pages and APIs (403, "not part of the … portal"). "Sign out" returns to the Admin Overview. Anyone who can reach the
server is Velza Admin, so keep it on this PC (`npx next dev -H 127.0.0.1`). Sessions started from the Role/User selects
stay valid after switching back on (AUTH-1).

**Re-enable sign-in.** Set `SIGN_IN=on` in `.env.local` (a running `next dev` switches over; reload). Then sign out once
in each browser that used the Role/User selects (AUTH-1).

**Production stays protected.** Since 30 Oct 2026 (F-01) a production build (`npm start`) **always requires sign-in**:
`SIGN_IN=off` is ignored there and the server logs "SIGN_IN=off is ignored in a production build". `SIGN_IN=off`
works only under `npm run dev`. Verified on a production build of the fixed code with `SIGN_IN=off`: pages go to
`/login`, APIs answer 401, dev-login and the act-as list answer 404 (`src/lib/signInMode.ts`, tests in
`src/lib/signInMode.test.ts`). **A server that was already running before this change keeps its old behaviour until
it is rebuilt and restarted** (the `npm start` on :3000 since 30 Oct 11:00 still has sign-in off).

**Data.** `data/db.json` was re-seeded again on 30 Oct 2026 at 10:38:29 IST, with the same signature as on 29 Oct:
0 partners, only AD0001/HQ0001 with new passwords, and AD0001 signed in at 10:38:43. The live Partners page therefore
shows **Partners (0)** and Sign-ins (2). This change did not restore it. The same duplicate-safe restore as on 29 Oct
brings back the 18 partners and 21 sign-ins.

**Verified (30 Oct 2026):**

| Check | Result |
|---|---|
| Live :3000, sign-in off, fresh browser (Edge 1440×900 and 390×844): `/` opens the Admin Overview (6 cards), no sign-in form, no cookie set; `/login` → Overview; all 6 Admin menu pages open; reload stays; `/hq` refused; no console errors | 24/24 PASS (Partners 0, Sign-ins 2: the live data) |
| Same on a production build (`127.0.0.1:3200`, `SIGN_IN=off`) with a copy of the live data plus the 18 partners restored into the copy | 24/24 PASS (Partners 18, Sign-ins 21) |
| Live :3000, sign-in off: dashboard, alerts, stock, my-partners APIs as the default Admin | 403 (role checks kept) |
| Production build, `SIGN_IN` = on / empty / `yes` / off | on, on, on, off; when on: `/` → `/login`, APIs 401 |
| Sign-in on (production build, copies of data): 19 partner sign-ins; all 21 incl. AD0001/HQ0001 (QA data): sign-in, wrong password, lockout, identity, 18-API permission matrix, hierarchy scope, logout | 583/584 and 639/640 PASS (miss = DEF-001) |
| Sign-in on, browser: 7 roles × 5 sizes + sign-in page light/dark | 309/309 PASS |
| Lint, typecheck, build, e2e 12/12; unit JSON 250/250 (+1 test for the default Admin); PostgreSQL `registration` 19/19, `access` 10/10 one file at a time | PASS (all PostgreSQL files at once time out starting the embedded database: INFO-4) |
| `data/db.json` before vs after testing | Unchanged (counts, hashes, file time) |

## Verification

Automated runs used a production build on `127.0.0.1:3200` with copies of the data, never `data/db.json`.

| Check | Result |
|---|---|
| 19 partner sign-ins on a copy of the merged data: sign-in, cookie flags, identity and partner context, 18-API permission matrix (same as QA report §5), bootstrap scope, My partners and dispatch destinations = exactly the assigned partners, logout + old cookie refused | 583 / 584 PASS (1 = DEF-001) |
| AD0001 and HQ0001 on a copy of the QA data (QA passwords) | 89 / 90 PASS (1 = DEF-001) |
| Live AD0001/HQ0001 refuse the QA passwords (seeded passwords preserved) | PASS |
| Not signed in: 17 APIs → 401, 6 portal pages → redirect to `/login`, `/login` and public `/t/<code>` load; `dev-users` and `dev-login` → 404; forged cookie → 401 | PASS |
| Wrong password and unknown ID → 401 `BAD_CREDENTIALS` (same message); 5 failures → `LOCKED` (429) for 5 min, also for the right password; no cookie on failure | PASS |
| Switching account: the new sign-in gets only the new account's role, partner and permissions | PASS |
| Browser (Edge), 7 roles × 1440×900, 1366×768, 768×1024, 390×844, 360×800, plus the sign-in page in light and dark: role menu, one `<nav>`, Account + Sign out, no act-as selects, no horizontal overflow, ID in header, no new console errors, other portal's page refused, Back after sign-out stays on `/login` | 309 / 309 PASS |
| Lint, typecheck, unit (JSON project 249/249; `access` 10/10 and `registration` 18/18 on PostgreSQL, one file at a time), build, 12-step browser demo | PASS (first JSON run had one file fail at start-up, two reruns 249/249) |

Not verified: the 12-hour expiry by waiting (checked through Max-Age and the code), the `Secure` flag over real HTTPS,
deactivating a sign-in (covered by the 28 Oct QA), a retailer assigned directly to an SS (none in the QA data; covered
by browser demo steps 5 and 11), physical phones.

## Open items

| ID | Severity | Summary | Status |
|---|---|---|---|
| AUTH-1 | P2 | Sessions started with "pick a person" while sign-in was off stay valid for up to 12 h after `SIGN_IN=on`, so a browser that acted as someone stays signed in without a password. Cleared on this PC by removing the 8 stored sessions. Proposed fix: mark sessions started by `devLogin` and refuse them while sign-in is on (`src/lib/services/auth.ts`) | Open — needs approval (authentication change) |
| DEF-001 | P3 | `GET /api/admin/settings` answers without sign-in | Open (unchanged) |
| DEF-003 | P3 | Signed in with sign-in on, every page logs a console 404 for `/api/auth/dev-users` | Open (unchanged) |
| — | Info | The sign-in page logs a 401 for `/api/auth/me` before anyone signs in (its "already signed in?" check) | Expected |

---

# Change log

Add one entry per change, newest first: date, who, what changed, files, and how it was verified. Update the affected
section above in the same change.

| Date | Who | Change | Verified |
|---|---|---|---|
| 13 Nov 2026 | Claude Code on `features/barcode-history` (uncommitted, as asked) | **Camera opens on the first click; rotated barcodes read** (Part 1 camera row unchanged in behaviour). Fixes: (1) the first **Use camera** click showed an error and only the second opened the camera. React runs the opening effect twice in development, so two starts overlapped; the browser aborted the first attempt's `video.play()` ("interrupted by a new load request") and that abort was reported as a camera failure and stopped the stream the second attempt was using. A start that has been superseded by a newer start or by Stop now ends quietly; a real failure of the current start is still reported. Follow-up the same day (the user still saw it): when the older attempt *succeeded* after the newer one had begun, its clean-up (zxing `controls.stop()` clears `video.srcObject`; ours stopped the tracks on the shared video) killed the newer camera's stream, so the panel said running with a black preview. Camera attempts on a session now run one after another (each waits for the previous to settle and clean up); an attempt superseded before it begins never opens the camera. (2) `@zxing/browser` 0.2.1 never initialises `tempCanvasElement`, so with TRY_HARDER every frame threw "Could not create a Canvas element." when trying the 90° rotation (console noise; sideways barcodes never read). `fixRotatedScans` defaults the field to null before the reader is created. Files: `src/lib/scan/camera.ts`, `src/lib/scan/scan.test.ts`. | 5 new unit tests (overlapping starts incl. the older one finishing last, start superseded by Stop, real failure still reported, real zxing class gets its canvas); they fail on the old `camera.ts`; full unit suite 878 passed / 9 skipped; `tsc` and ESLint clean; live check on :3000 as RT0001 on /receive: camera opened on the first click on every try, no canvas errors in the console (first fix). Follow-up confirmed live by the user on 13 Nov: the camera opens on the first click on all screens. |
| 13 Nov 2026 | Claude Code on `features/barcode-history` | **Returns: Velza field staff, take back, warehouse inspection, HQ Returns report** (Part 1 "Roles and responsibilities": new role row and *Returns* paragraph; "Statuses": Return in transit, Returned, Expired). From the user's spec: role `VELZA_FIELD` (VF0001…) whose Scan screen is view only with the full chain; info card for HQ / Admin / field staff (full chain with partner, date and time, invoice; holder, status, Mfg / Exp date, days to expiry); Take back (Not selling / Near expiry / Damaged / Other + note) → `RETURN_IN_TRANSIT` to the Velza Warehouse with a `RETURN_PICKUP` movement; a pack from a sealed case/tray opens that lot first; warehouse scan → `RETURNED`, then Back to stock (`AT_WAREHOUSE`) or Write off (`DAMAGED` / `EXPIRED`); HQ dashboard Returns report. Schema v6. Also fixed: the *Product details* pack label said "Pack n of <cans per pack>" — a case is 4 packs of 6 cans, a tray 6 packs of 4 — now "Pack 3 of 4 (6 cans)" and "4 packs of 6 cans". Live data (`data/db.json`, backup `data/db.backup-2026-11-13-before-returns.json`): registered VW0001 **Velza Warehouse Bhiwandi**, **DB0001 Pune Distributor - Hadapsar** under SS0001 (first added as a dummy distributor), RT0002 **Pune Retailer - Hadapsar** under DB0001, field sign-in VF0001 *Velza Field Staff 1* (renamed from their test names the same day; names by position, no company names yet). The dev server running since before the 12 Nov merge must be restarted: its in-memory store predates `appendMovements` / `updateWhere`, so creating a print order gives a 500 there. | typecheck + eslint clean; vitest all files (JSON + PostgreSQL) incl. new `tests/unit/returns.test.ts` (field view-only + full chain, pack return opens the lot, returned item not receivable / sellable elsewhere, back to stock vs write-off, report); browser on a production build (:3200) with a copy of the live data: 2 new cases MF → VW0001 → SS0001 → DB0001 → RT0002, field Scan + full chain + Take back (case, and a pack that opened its case), other partners WRONG_RECEIVER, warehouse Receive → RETURNED → Back to stock (dispatchable again) / Write off: Expired (refused, public "Expired"), HQ Returns report with all 10 columns |
| 13 Nov 2026 | Claude Code on `features/barcode-history` (from `develop/aditya` @ `276a7f9`) | **Product details at every level** (Part 1 "Roles and responsibilities": new *Product details* paragraph and portal screens). From the user's note: scanning a barcode at any level from MF to RT shows the details (Mfg. date, Expiry date); at a Retailer it shows Mfg. date, Exp date, Batch No. and from which DB and SS the pack came. New page `/details` (menu *Product details*) for Operator, QC, Velza Warehouse, SS, DB and Retailer: flavour, Batch No., Mfg. / Expiry date with days left or Expired, pack n of m and its case/tray, where it is now, and the supply chain to you (plant → each partner it was received at, with date and invoice → you); Retailers get a "Came to you from" card (Super Stockist, Distributor, Velza Warehouse). Recalled or expired → do-not-sell warning. Disclosure: only codes at, on their way to, or passed through the viewer (plant: its own codes); anything else answers like an unknown code; the chain never goes past the viewer; status shown only while here or on its way to / from you. Scans logged as `LOOKUP` (no alert). New permission `details`; `GET /api/details/<code>`. Files: `src/lib/services/details.ts`, `src/app/api/details/[code]/route.ts`, `src/app/(screens)/details/page.tsx`, `src/lib/core/permissions.ts`, `src/lib/menu.ts`, `tests/unit/productDetails.test.ts` (new, 12 tests), `tests/e2e/demo.spec.ts` (step 6b). | typecheck + eslint clean; vitest 847 passed + 9 skipped (57 files, JSON and PostgreSQL); `productDetails.test.ts` 24/24 (both stores: Retailer-1 pack → SS-1 + DB-1 + VW-1, dates, batch, Pack 3 of 6; direct-SS retailer → no DB; in transit; plant / VW / SS / DB see the chain only up to themselves; other retailer, other SS, unknown and junk codes → UNKNOWN_CODE with nothing leaked; HQ / Admin 403, signed out 401); Playwright e2e 20/20 incl. 6b in the browser (Retailer-1 sees SS-1 and DB-1, 5-step chain; SS-1 sees 3 steps and no DB-1 / Retailer-1; Retailer-2 gets Unknown code) |
| 13 Nov 2026 | Claude Code on `develop/aditya` | **Warehouse work merged with `main` (PR #3 / #4); Abhay's 12 Nov merge repaired.** The 6 Nov warehouse/containers work (`2ff5f9e`, also on `feature/velza-warehouse`) was merged with `origin/develop/aditya` @ `23d2836`, where `main` had been merged in on 12 Nov. That merge had kept both sides of its conflicts in `ScanInput.tsx`, `PrintView.tsx`, `printOrders.ts`, `trace.ts`, `damage.ts`, the printed route, the HQ alerts page and two tests (duplicate functions; `tsc` failed on `main` too). Re-merged from the two parents, keeping both behaviours: cases and trays still print and confirm as **separate runs** (`{ lotType }`) on top of PR #3's print-once sheet, one-time reprints and bulk `markPrinted` (`{ deviceId }` accepted too; the order is PRINTED only when no run is waiting). Camera: PR #3's `CameraSession` now asks for 1920×1080, `TRY_HARDER` and continuous focus, exposes the resolution, and the scan box keeps the camera open between QC steps and warns below 1280 px. Damage reports keep the required photos and take the cleaned scan code. HQ alert rows carry both the alert state and `photoUrls`. PostgreSQL schema renumbered: warehouse + containers are **v5** (v3 = code integrity, v4 = indexes, from `main`); `containers` added to the clear-activity list. `AT_WAREHOUSE` added to the public "Genuine" and sellable status lists. Receive page: no client-side 15/17-character check for the warehouse (container numbers). Tests from `main` that shipped plant → SS directly now go through the warehouse; `reportDamaged` calls send the photos. | typecheck + eslint clean; vitest 823 passed + 9 skipped (55 files, JSON and PostgreSQL, 2 workers); Playwright e2e 19/19 (`demo.spec.ts` 12 + `scanning.spec.ts` 7; the dispatch/receive checklist test now ships to VW-1). Not tested: in-place upgrade of a real PostgreSQL database from v4 to v5 |
| 6 Nov 2026 | Claude Code on `develop/aditya` | **Velza Warehouse tier and shipping containers** (Overview, "Working model structure" incl. new "Velza Warehouse and shipping containers", Statuses, Partner tree, Workflow, onboarding, "How each location connects" and Roles updated). At the user's request the pipeline changed: the plant dispatches containers to the Velza Warehouse, which distributes to SS, DB and Retailers. Decisions (user, 6 Nov): a container holds up to 2,860 cases/trays and carries its own number, entered in the system for container tracking; after the warehouse the old chain continues (SS → DB → Retailer, SS → direct Retailer); the warehouse may supply any SS, DB or Retailer (no assignment); one warehouse for now, more can be registered later. **Tier:** partner type `WAREHOUSE` (IDs VW0001…, label Velza Warehouse), role `WAREHOUSE` (sign-in = partner ID; Receive, Containers, Dispatch, My stock, Damaged), status `AT_WAREHOUSE`; `DESTINATION_TYPES`: Manufacturer → Warehouse only, Warehouse → SS/DB/Retailer; `isAssignedDestination` lets the warehouse supply anyone; Admin Partners texts and the Dispatch subtitle updated. **Containers:** new `containers` table/collection (one row per trip: number, plant, status LOADING/IN_TRANSIT/RECEIVED, lot codes, warehouse, invoice, who/when); `src/lib/services/containers.ts` + `/api/containers` (list, open, detail, cancel, load, unload, dispatch); Receive accepts a container number (`receiveContainer`); dispatch and receive steps shared with single scans (`dispatchItems`, `receiveItem` in `movement.ts`); movements note "Container <number>"; scan context `CONTAINER`; permission `container` (Operator, Warehouse, HQ); new *Containers* page. **PostgreSQL:** schema v3 (renumbered v5 on 13 Nov, after the code-integrity v3 and index v4 from `main`) — new allowed values in the partner type, ID, sign-in, role and code status checks (re-applied by the upgrade section), and the `containers` table with a unique index on the number among unfinished trips; `db/schema.sql` regenerated. Existing stock already at or on its way to an SS is unaffected. QA script `tests/qa/qaRun.ts`: role matrix skips WAREHOUSE (the QA dataset has no warehouse sign-in yet). | typecheck + eslint clean; vitest JSON store 378/378 (rules: MF → VW only, VW → any SS/DB/RT, AT_WAREHOUSE; demo script via VW incl. VW → DB/Retailer directly; new `containers.test.ts`: number checks, loading rules, all-or-nothing dispatch, receive by number incl. partial/wrong receiver/duplicate, HQ timeline, number reuse; QA dataset: registered VW is the plant's only destination); PostgreSQL: containers, demo script and damage tests 28/28; `playwright demo.spec.ts` 13/13 (plant → VW → SS-1 in the UI, new step 12: container loaded, dispatched and received by its number). Not yet: a real v2 PostgreSQL database upgraded in place (the upgrade re-applies the checks the same way as v1 → v2) |
| 6 Nov 2026 | Claude Code on `develop/aditya` | **No minimum for cases or trays** (Part 1 "Units and codes" and continuation checks updated). At the user's request, cases and trays are each 0 or a whole number with no compulsion. Before, a batch with 0 cases and 0 trays was refused ("enter at least 1 case or 1 tray (both are 0)") and an emptied box was an error. Decision (user, 6 Nov): 0 + 0 is allowed for a batch — it takes its batch code, gets no lot numbers (the counter stays at 00001) and is filled later with *Continue an existing batch*. Still refused, because nothing would print: a whole new order where every batch is 0 + 0 (400 `INVALID_ORDER`, "Nothing to print") and a continuation of 0 + 0 (400 `INVALID_QUANTITY`). New batches and Continue: an empty box counts as 0; negative or fractional counts still say "must be 0 or a whole number". Files: `src/lib/core/printOrder.ts`, `src/lib/services/printOrders.ts`, `src/app/(screens)/operator/new/page.tsx`, tests. | typecheck + eslint clean; vitest JSON store 369/369 (new: 0-tray and 0 + 0 batches plan fine, all-zero order refused, 0 + 0 batch created with no lots and continued from 00001, 0 + 0 continuation refused); `playwright demo.spec.ts` 12/12 |
| 6 Nov 2026 | Claude Code on `develop/aditya` | **Cases and trays printed as separate runs** (Part 1 "Working model structure" and "Statuses" updated). At the user's request: case and tray stickers go on different label rolls and are stuck on differently, so they are never printed in one run. Decisions (user, 6 Nov): same sticker sizes for both rolls; each run confirmed on its own. Print view: new **Print run** choice (Cases · n lots, m stickers / Trays · …, each marked *To print* or *Printed*; the first run still to print is selected); the preview, **Print n case/tray stickers** and the size warnings cover the chosen run only; **Mark cases as printed** / **Mark trays as printed**. Server: every sticker carries `lotType`; the order's sheet has `runs` (`lotType`, lots, stickers, pending); `POST /api/print-orders/<id>/printed` takes `{ lotType }` — only that run's GENERATED lots (and packs) become PRINTED, and the order becomes PRINTED with its time only when no lot of any run is waiting; repeating a run changes nothing; a run the order lacks is 400 `NOTHING_TO_PRINT`. Without `lotType` (or with no body) the whole order is confirmed as before, so scripts keep working. Reprints are unchanged (one sticker). Files: `src/lib/core/stickers.ts`, `src/lib/services/printOrders.ts`, `src/app/api/print-orders/[id]/printed/route.ts`, `src/components/PrintView.tsx`, tests. | typecheck + eslint clean; vitest JSON store 366/366 (new: runs on the sheet, cases confirmed alone → order still pending, QC verifies the cases and refuses the trays, then trays → order PRINTED; missing/bad run refused); `playwright demo.spec.ts` 12/12 — cases run (10 stickers) and trays run (14) each decoded, printed and confirmed separately |
| 6 Nov 2026 | Claude Code on `develop/aditya` | **One batch, one flavour: flavour change on existing batches removed** (Part 1 "Continuing a batch" updated; reverses the 5 Nov flavour switch, 5938ed1). At the user's request a batch carries one flavour only. *Continue an existing batch*: step 2 is "Cases & trays" again, with no flavour picker; new lots always take the batch's flavour. Server: `POST /api/print-orders/continue` no longer takes a flavour choice — a request naming another flavour gets 400 `FLAVOUR_CHANGE_NOT_ALLOWED` (preview too) and allocates nothing; the batch's own flavour is accepted. Kept on purpose: screens show each lot's own flavour (lot lookup, Batches, batch report, Print orders) and a flavour used by lots cannot be deleted, so lots already printed with a switched flavour still display and stay consistent; the whole-row click on *Choose batch* (also from 5938ed1) stays. Files: `src/lib/services/printOrders.ts`, `src/app/(screens)/operator/new/page.tsx`, `tests/unit/continuation.test.ts`. | typecheck + eslint clean; `continuation.test.ts` 54 pass / 2 skipped on JSON and PostgreSQL (new: another flavour refused without allocating, own flavour accepted); full vitest: all JSON-store tests pass, the 7 PostgreSQL files that time out in setup on this branch (no `9a9fc53`) unchanged. Not clicked through in a browser |
| 6 Nov 2026 | Claude Code on `develop/aditya` | **QR code removed from lot (case/tray) stickers; barcode only, a little bigger than the pack barcode** (Overview, "Working model structure", "Connection establishment" and roles table updated). At the user's request, lot stickers now carry just the header, the Code 128 barcode and the code text, laid out like a pack sticker. The lot barcode may grow to 0.4 mm bars × 18 mm (SPEC `lotMaxModuleMm`, `lotMaxBarHeightMm`), so at the default sizes it is ≈ 80 × 18 mm against ≈ 67 × 14 mm on a pack. Unchanged on purpose: scanners and the damage-photo check still read QR codes, so cases already printed with a QR keep working; the public page `/t/<code>` and the "Public base URL" setting stay (card renamed "Public page"). New stickers therefore give consumers no QR to scan. Files: `src/lib/stickerLayout.ts`, `src/components/Stickers.tsx`, `src/lib/core/stickers.ts`, `src/lib/barcode.ts`, `src/lib/services/printOrders.ts`, admin settings page, tests. | typecheck + eslint clean; `vitest src/lib` 216/216 (new: lot barcode bigger than pack by at most 40 %, no QR on lot sticker); `playwright demo.spec.ts` 12/12, every printed barcode decodes and no sticker has a QR |
| 5 Nov 2026 | Claude Code on `develop/aditya` | **Photos of the damage required** (4942408; Part 1 damage paragraph, statuses and workflow updated). Besides the required barcode photo, a damage report must add 1 to 4 photos of the damage itself (close-ups, other sides), without a barcode — compulsory at the user's request (first built as optional). Damaged page: new step 4 "Photos of the damage" (report button disabled until at least one is added) — several at a time, thumbnails with a remove button; the report button is now step 5. Server: `damagePhotos` (array of data URLs): at least 1 (`DAMAGE_PHOTO_REQUIRED`), at most 4 (`TOO_MANY_PHOTOS`), each a real JPEG/PNG/WebP ≤ 1 MB (`PHOTO_INVALID` / `PHOTO_TOO_LARGE` naming the photo); stored as `<report id>.<n>.<ext>` with the barcode photo in the same last step of the transaction (a failed write removes the files already written); served by `GET /api/damaged/photo/<id>?n=<n>` to the reporter and HQ only. `listDamaged` and HQ alerts now return `photoUrls` (barcode photo first) instead of `photoUrl`; Damaged list and HQ Alerts show every photo. Body limit of the damage route raised to fit 2 MB + 4 × 1 MB. Files: `src/lib/services/damagePhotos.ts`, `src/lib/services/damage.ts`, `src/lib/services/trace.ts`, `src/lib/damagePhotoClient.ts`, `src/app/api/damaged/route.ts`, `src/app/api/damaged/photo/[id]/route.ts`, `src/app/(screens)/damaged/page.tsx`, `src/app/(screens)/hq/alerts/page.tsx`, `tests/fixtures/damagePhoto.ts` (every test report sends one damage photo), `tests/unit/damage.test.ts` (+1 test), `tests/e2e/demo.spec.ts` (step 10: button stays disabled with only the barcode photo; two damage photos added, one removed, 2 photos on Damaged and HQ Alerts). | Typecheck, lint; damage unit tests (JSON and PostgreSQL): no / empty / blank damage photos → `DAMAGE_PHOTO_REQUIRED`, 5 photos refused, non-image and > 1 MB refused naming the photo, case unchanged; 2 extra photos stored after the barcode photo, URLs in order on Damaged and HQ alerts, PNG/JPEG served, photo 3 and n=1.5 → 404, other SS → 404. Full unit suite 511 passed + 4 skipped (37 files, JSON and PostgreSQL, 2 workers; optional version), damage + scalability tests 62/62 after making them required; E2E 12 of 12 passed |
| 5 Nov 2026 | Claude Code on `develop/aditya` | **Pack barcodes could not be scanned from the screen** (f914e5b; follow-up to the camera fix below). After the camera fix the camera ran at 1280×720 and the case still scanned, but packs did not. Cause: not the camera. The sticker sheet draws stickers at real size, so a narrow bar (0.25–0.33 mm) is about 1 screen pixel; the browser rounds each bar edge to a whole pixel, the bars come out uneven, and Code 128 cannot be decoded even from a perfect screenshot (checked: real-size screenshots at screen scaling 100 % and 125 % → no code; user's phone photos of the screen → only the case QR, which is coarse enough). The case "worked" only through its QR. Printed stickers are not affected (a label printer draws 0.25 mm as 2–3 dots). Fix: the print view has "Enlarge on screen to scan from the monitor" (on by default): on screen only (`@media screen`, CSS `zoom`), each sticker is enlarged so a narrow bar is a whole number of screen pixels, at least 3, following browser zoom and screen scaling. Printing is unchanged (real size). Files: `src/components/Stickers.tsx`, `src/components/PrintView.tsx`. | Typecheck, lint; Edge screenshots of the real print page on the test system: real size → not decodable, enlarged → `914BCSZLOR0000B61` decoded at 100 % and 125 % scaling, also after shrinking to 640 px; print media → sticker still 75 mm wide. E2E 12 of 12 passed |
| 5 Nov 2026 | Claude Code on `develop/aditya` | **QC could scan the case but not its packs with the camera** (f914e5b). Scan log of the test system: the lot scanned, then no pack scan ever reached the server, so the packs were never decoded. Cause: the camera was opened without a size, so browsers gave 640×480; a pack sticker's Code 128 bars (≈0.33 mm on 75 mm) were then ≈1.8 px wide — below what ZXing can read — while the lot sticker's QR still read. Simulated decode of the real symbols: 640×480 pack NOT read / QR read; 1280×720 and 1920×1080 both read. Fix in `src/components/ScanInput.tsx`: ask for 1920×1080 (ideal) with continuous autofocus where supported, ZXing `TRY_HARDER`, show the camera's resolution with a hint below 1280 px, and keep the camera open when the page re-creates the scan box (QC lot → packs closed it every time). Stickers unchanged, so printed stickers keep working. | Typecheck, lint; decode simulation above; e2e regression: 12 of 12 passed. Not checked with a physical camera (the browser's permission prompt can't be automated here) |
| 5 Nov 2026 | Claude Code on `develop/aditya` | **Damage reports need a photo with the barcode** (Part 1 "Roles and responsibilities" damage paragraph, statuses and workflow updated). Damaged page: reason → scan → photo (camera on phones, file on PCs) → Report; the barcode/QR in the photo is read in the browser and must match the scanned code. Server: photo required, real JPEG/PNG/WebP ≤ 2 MB, code read from it = reported code (400 `PHOTO_REQUIRED` / `PHOTO_INVALID` / `PHOTO_TOO_LARGE` / `PHOTO_NO_BARCODE` / `PHOTO_BARCODE_MISMATCH`), checked after the permission check; stored on disk as `<upload dir>/damage/<report id>.<ext>` as the last step of the transaction (no schema change); served to the reporter and HQ only. Photo shown on Damaged and HQ Alerts. Damage route body limit raised to fit one photo (`jsonBody(req, maxBytes)`). The browser reader tries 1200/800/1600 px and a light blur: at full size alone, sensor noise around the sticker made ZXing miss clean codes. Files: `src/lib/services/damagePhotos.ts` (new), `src/lib/damagePhotoClient.ts` (new), `src/app/api/damaged/photo/[id]/route.ts` (new), `src/lib/services/damage.ts`, `src/lib/services/trace.ts`, `src/lib/api.ts`, `src/app/api/damaged/route.ts`, `src/app/(screens)/damaged/page.tsx`, `src/app/(screens)/hq/alerts/page.tsx`, `tests/unit/damage.test.ts` (+3 tests, existing reports now send a photo), `tests/unit/scalability.test.ts`, `tests/fixtures/damagePhoto.ts` (new), `tests/e2e/demo.spec.ts` (step 10: wrong-code photo refused, sticker QR photo accepted, photo on Damaged and HQ Alerts), `playwright.config.ts` + `tests/e2e/global-setup.ts` (e2e photos in `data/e2e-uploads`). | Typecheck, lint; unit 509 passed + 4 skipped (37 files, JSON and PostgreSQL, 2 workers); live browser test on an isolated dev server (throwaway sample data, packed Green Apple cases): noisy, rotated JPEG "phone photos" built from the real sticker symbols — wrong case's Code 128 refused in the page, own QR at 15° accepted, report saved, photo served 200 (1600 px JPEG) and shown on Damaged and HQ Alerts; direct API calls without photo / wrong code / no barcode / not an image → 400, case still packed; photo: Super Stockist 404, QC 403, reporter 200. Production build + e2e 12/12 on the JSON store (step 10 with real sticker-symbol photos; photos in data/e2e-uploads, nothing in data/uploads) |
| 5 Nov 2026 | Claude Code on `develop/aditya` | **Switch flavour when continuing a batch** (5938ed1; **removed 6 Nov 2026**, see above; Part 1 "Continuing a batch" updated). Replaces the 30 Oct rule "a batch is one flavour". The continue request takes an optional `flavour` (default: the batch's), checked as an active flavour (400 `INVALID_FLAVOUR`); new lots and packs get that flavour in their code and row; the counter stays per batch. Idempotent replay also compares the flavour. Display fixes for mixed-flavour batches: lot lookup shows the lot's flavour (was the batch's), Batches / batch report list all flavours, Print orders show each order's flavour; deleting a flavour is refused while continued lots use it. UI: step 2 is now *Flavour, cases & trays* with a flavour picker (shared `FlavourPicker`, also used by New batches), switch notice, summary "was …", result names the flavour. Files: `src/lib/services/printOrders.ts`, `src/lib/services/trace.ts`, `src/lib/services/admin.ts`, `src/app/(screens)/operator/new/page.tsx`, `tests/unit/continuation.test.ts` (+3 tests). | Typecheck (no errors outside stale `.next` types), lint; continuation tests 58 passed + 2 skipped on JSON and PostgreSQL; full unit suite 423 passed — 6 PostgreSQL files hit the 10 s setup-hook timeout under full parallelism and pass 160/160 when re-run with 2 workers (fix `9a9fc53` is on `feature/barcode-scanner`, not on this branch). Browser click-through on an isolated `next dev` (port 3500, throwaway sample data, sign-in off): batch P1VUEF Original lots 00001–00002, continued as Green Apple → `…GA00003`–`00004` (packs GA), switch notice and summary "was Original" shown, sticker header "CASE \| GREEN APPLE", Print orders per-order flavour, HQ Batches "Original, Green Apple", HQ search shows Green Apple. A stale `.next/dev` cache from the other branch caused a dev reload loop; removed. Follow-up: on *Choose batch* only the 13 px radio selected a batch (clicking the row did nothing, so Next stayed disabled); the whole row is now clickable, radio enlarged; checked live on :3500 |
| 5 Nov 2026 | Claude Code (7 agents) on `feature/traceability-flow-completion` (from `feature/barcode-scanner` @ `9a9fc53`) | **Traceability flow completion: fixes from the 4 Nov "Tested Application Flows" report** (uncommitted). **Admin:** sign-in lockout per ID + client IP, with the count reset when a lock expires; when `CLIENT_IP_HEADER` is unset (X-Forwarded-For can be spoofed), an extra per-ID limit of 20 failures from any IP applies; clientIp uses the rightmost X-Forwarded-For hop and warns in production. Deactivation refused for a partner with stock in transit to it (`IN_TRANSIT`) and for the default or a used country (`IN_USE`). Devices locked to their plant (`PLANT_LOCKED`). Inactive parent or plant refused. Phone numbers with and without +91 or a leading 0 count as one. QR base URL must be https (http only for localhost/LAN). Pool refill level ≤ issue size. A staff sign-in with a partner is refused. Bootstrap settings go to Admin only (`session.tsx` `settings?`). **HQ:** recalled, void, quarantined and unverified (GENERATED/PRINTED) stock is left out of normal stock and shown in its own Recalled / awaiting-QC lines; a lot recalled in transit shows at the intended receiver. Recall keeps DAMAGED; no recall report for a batch that is not recalled; VOID lots not counted in the recall confirmation; recall reads packs once per batch, reason bounded. Alerts: HQ-only acknowledge / close / reopen (append-only `ALERT_*` movement rows), paging, repeated failures grouped per hour, HQ's own searches raise no alert. Opened lots with no packs left are no longer listed; the lot timeline includes pack events. **Plant:** mark-as-printed in bulk (`Repo.updateWhere`, `StoreTx.appendMovements`); preview and create send a summary, not every code. New-order lot cap = the continuation cap (10,000 PostgreSQL / 1,000 JSON), refused whole. Print / reprint / void / sync / mark-printed need a PC at multi-PC plants (`DEVICE_REQUIRED`, "This PC" in the DeviceBar). Void needs a reason. Date checks: manufacture date at most 1 day ahead, shelf life at most 5 years (provisional). PostgreSQL schema v4 (7 indexes, `IF NOT EXISTS`). **Chain:** receive, dispatch and open-lot accept a full QR link, lower case and padding (server-side); location is checked before status, so a non-holder learns no status; open-lot wording fixed. **Public / security:** the public page uses an allowlist: only QC-passed stock is "Genuine"; GENERATED/PRINTED say "Not yet released"; VOID shows no details; DAMAGED is logged not-OK; RECALLED says "Recalled — do not consume". Junk input is not logged; one log per client per 10 minutes; `SUSPECT_CLONE` alert (provisional 5 scans / 24 h, Admin settings); unknown and blocked public scans give one summary alert each. The live route `/api/lookup/<code>?view=public` now delegates to `verify.ts publicCheck`. demo-codes filtered by role; a malformed `%` in `/t/<code>` no longer throws; `clear-activity` guarded (shows target, `--force`, backup, refuses production / ambiguous targets). Already fixed before this change: print-order idempotency (#1), JSON lock (#5), sticker serving (#14). **Deferred (business decision):** return-to-plant / write-off (#8), cancel / redirect of stranded consignments, SOLD state, loose-pack QR. Device binding to the session at sign-in is deferred (technical). New files: `scripts/clearActivityGuard.ts`, `src/app/t/[code]/codeParam.ts`, `src/lib/publicUrl.ts`, `src/lib/scan/scannedCode.ts`, `tests/qa/printBench.ts`; tests `src/lib/core/publicSafety.test.ts`, `tests/unit/{adminValidation,clearActivity,printOperations,publicSecurity,traceFlow}.test.ts`. | Typecheck, lint pass; unit (JSON + PGlite) 783 passed + 9 skipped in 53 files (baseline 590 + 7 in 42); e2e 18/18 JSON and 18/18 PostgreSQL (port 3100). Benchmarks (`tests/qa/printBench.ts`, service layer, throwaway stores): 5,000-lot mark printed 13.0 s → 0.32 s JSON, 115 s → 2.1 s PGlite; preview 939 KB → < 1 KB. Independent QA found 2 P1 issues (lockout bypass by faking X-Forwarded-For; the live public route not using the new checks); both fixed and covered by tests. Not tested: real reverse proxy, index build time on a large database, multi-PC picker in a browser, physical printers / scanners |
| 4 Nov 2026 | Claude Code (isolated copy `crms_velza_trace_serialfix`, from `feature/barcode-scanner` with its uncommitted work) | **Serial uniqueness and duplicate-print protection** (audit P0–P2; uncommitted; Part 1 "Serial integrity and duplicate-print protection" added). P0: the JSON store gets an exclusive `<file>.lock` held by one process (a second process gets 503 `STORE_LOCKED`), stale-lock takeover and a changed-on-disk check before each write (`src/lib/store/jsonStore.ts`). P1: sticker sheets only while CREATED, only GENERATED lots, each serving logged; 409 once PRINTED; single stickers only through a logged reprint, served once (`POST /api/reprint/<id>/stickers`; `GET /api/stickers` → 410); new-batch orders need an idempotency key with a request fingerprint. P2: a continuation replays only a continuation with the same fingerprint; per-manufacturer advisory lock before `BEGIN`, contention → 409 (no raw 500); every transaction query runs one at a time; PostgreSQL schema v3: `print_orders.order_kind`, `request_fingerprint`, `code_history.print_order_id`, triggers `batches_counter_forward_only` and `codes_issued_protected` (the JSON store has the same guards). Files: `src/lib/core/types.ts`, `src/lib/store/{Store,index,jsonStore}.ts`, `src/lib/store/sql/{driver,schema,sqlStore}.ts`, `db/schema.sql`, `src/lib/services/{printOrders,operator}.ts`, `src/lib/api.ts`, `src/app/api/stickers/route.ts`, `src/app/api/reprint/[id]/stickers/route.ts` (new), `src/app/print/code/[code]/page.tsx`, `src/app/print/reprint/[id]/page.tsx` (new), `src/components/PrintView.tsx`, `(screens)/operator/{new,orders,reprint}/page.tsx`. Tests: `tests/unit/serialIntegrity.test.ts` (new, 21), `tests/fixtures/jsonLockProbe.ts` (new), `tests/qa/serialMultiProcess.ts` (new); adapted: idempotency keys in every order-creating test/QA script, `continuation.test.ts` (no counter rewinds), `printConfirmation.test.ts` (sheet serving logged), `demoScript.test.ts`, `store.contract.test.ts`, `tests/e2e/demo.spec.ts` (printed sheet refused, reprint prints once). | Lint, typecheck; unit JSON 418 passed + 1 skipped (28 files); PGlite 172 passed + 6 skipped (14 files); real PostgreSQL 17 (throwaway, port 5499): `serialIntegrity` + `continuation` 44 passed + 4 skipped, whole unit suite 170 passed (2 `access.test.ts` failures that the original code also has on a real server); v2 → v3 upgrade of a database made by the original code: data unchanged, legacy continuation replays, triggers active; two processes × 20 requests: PostgreSQL 40/40 allocated, 0 duplicates (before: 23/40, 17 refused), JSON second process refused, 0 duplicates (before: 19 lots handed out twice, 20 orders lost); HTTP on ports 3470/3471 (sign-in on): every case answered as designed, 715 codes / 0 duplicates; production build + e2e 18/18 (port 3100) |
| 4 Nov 2026 | Claude Code on `feature/barcode-scanner` (from `0a1b09b`) | **Camera / USB / Bluetooth scanning and live scan checklists** (uncommitted; Part 1 "Scanning" added under "How each location connects"). Reused: `@zxing/browser`, the scan APIs, services, rules and scan audit (no new dependency, API or log). New: `src/lib/scan/normalize.ts` (control-character stripping, upper-casing, 15/17-character format check), `src/lib/scan/gate.ts` (one scan at a time, camera repeat-frame suppression), `src/lib/scan/camera.ts` (camera session: rear camera, camera choice, torch, permission/unavailable/busy/insecure messages, one session per page, every track stopped), `src/lib/scan/checklist.ts`, `src/components/ScanChecklist.tsx`; `src/components/ScanInput.tsx` rewritten on top (same selectors, labels and `onScan` contract; queue for fast scanners). Screens: QC Verify (pack checklist, Confirm only at 100%; fixed: a pack scanned right after the lot was lost because the scan box re-mounted), Dispatch (eligible-stock checklist, Remove), Receive (incoming checklist with invoice). Server: incoming stock items carry their dispatch `invoice` (`src/lib/services/trace.ts` `myStock`). Tests: `src/lib/scan/scan.test.ts` (26, mocked camera), `tests/unit/scanWorkflows.test.ts` (14: QC, dispatch/receive, audit, invoice, role × scan-API matrix incl. anonymous), `tests/e2e/scanning.spec.ts` (6: fake-camera video of a real Code 128 decoded by zxing, keyboard-wedge burst, partial input, duplicates, permission refused, camera released on navigation, phone width, dispatch/receive checklists); `tests/qa/scanPerf.mjs` (results `docs/qa/scan-perf-results.json`). Manual hardware guide: `docs/MANUAL_QA_GUIDE.md` §8. | Unit JSON 397 passed + 1 skipped (27 files); PostgreSQL (PGlite, serial) 154 passed + 3 skipped (13 files); lint, typecheck; production build + e2e 18/18 (port 3100, isolated copy); performance on a throwaway server (port 3430, 1,000 cases, JSON store, write rate limit raised for the test only): QC pack-scan API p50 57–68 ms / p95 85–112 ms (10/100/500 scans), dispatch checklist with 1,000 units loads in 1.8 s with 50 rows in the DOM, scan → SCANNED in the browser p50 247 ms / p95 270 ms over 100 scans, 100 requests for 100 scans, JS heap 4.7 → 5.8 MB, filter + search 183 ms. **Not run:** physical phones, USB/Bluetooth scanners; responsive pass of the scan screens in light/dark at 5 sizes (stopped: low memory); camera tested only through the browser's fake camera |
| 4 Nov 2026 | Claude Code | **System readiness review and management demo** (uncommitted). Audit by re-running and extending the test harnesses on isolated instances (never `data/db.json`, never :3000). Fixed: **DEF-001** settings readable without sign-in → Velza Admin only (`src/lib/services/admin.ts` `getSettings(userId)`, `src/app/api/admin/settings/route.ts`, test in `tests/unit/access.test.ts`); **phone-width sideways scrolling** on Admin → Partners ("Show" filter wider than the screen) and Countries & flavours (grid column without `min-w-0`) (`admin/partners/page.tsx`, `AdminCrud.tsx`). New tooling: `tests/qa/demoSetup.ts` (builds the DEMO- network and stock story through the real API with 31 lifecycle checks; refuses `db.json` and :3000), `tests/qa/demoUi.mjs` (every page of every role at 1440/1366/768/390 px: title, errors, overflow, raw errors, dev controls, focus, sign-out; refuses :3000). New doc `docs/MANAGEMENT_DEMO.md` (functionality matrix, 30–45 min script, demo sign-ins without passwords, architecture, limitations, start/stop/reset); `docs/CRMS_STATUS.md` updated. Demo workspace `C:\Users\ADMIN\velza-demo` (own app copy, data, random passwords, 127.0.0.1:3400). Still open: AUTH-1, DEF-002, DEF-004, INFO-1 (decision), no 2FA, session expiry untested, hardware untested. | Unit JSON 357 passed + 1 skipped; PostgreSQL (PGlite, serial) 140 passed + 3 skipped; lint, typecheck; build + e2e 12/12 (port 3100); API harness 101 PASS / 0 FAIL / 1 decision (port 3410, throwaway data); demo build-up 31/31; demo browser check 873/873; script steps 5–16 rehearsed 16/16 on a data copy (port 3420) |
| 4 Nov 2026 | Claude Code | **Explicit print confirmation** (uncommitted; Part 1 "Statuses" updated). **Print** in the print view now only opens the browser print dialog; before, it marked the order printed after the dialog closed even when it was cancelled. Only **Mark as printed** (the existing transaction) records printing: one request at a time (double-click guard), spinner while running, success message with the printed time, status refreshes to PRINTED; failures say "Not marked as printed: …". Nothing is inferred from the dialog, Ctrl+P, a CSV download, navigation or a timeout. Server: an order whose lots are all voided can no longer be marked printed (`NOTHING_TO_PRINT`); voided lots stay void when the rest of the order is confirmed. Files: `src/components/PrintView.tsx`, `src/components/PrintOrderStatus.tsx` (guidance text), `src/lib/services/printOrders.ts`, `tests/unit/printConfirmation.test.ts` (+6 tests: nothing recorded by print view / codes / order list, injected mid-transaction failure rolls back everything, unknown and all-voided orders refused, voided lots stay void, a printed order never returns to pending through reprint/void/QC/repeat confirmations, QC and HQ refused), `tests/e2e/demo.spec.ts` (Print → no request and order still CREATED; CSV download and leaving/reopening the print view record nothing; double-clicked Mark as printed → exactly one request, PRINTED with time), `README.md`, `ASSUMPTIONS.md`. | Lint, typecheck pass; unit JSON 356 passed + 1 skipped (25 files); PostgreSQL (PGlite, `--no-file-parallelism`) 139 passed + 3 skipped (12 files); print confirmation tests 13/13 on both stores; production build + e2e 12/12 in an isolated copy (port 3100, own data); `data/db.json` and :3000 untouched |
| 4 Nov 2026 | Claude Code | **QC "not printed yet" made actionable; printing state visible** (uncommitted). Cause of the reported Verify errors: print order `e133e1dc` (batch 3XIGAX, 100 lots) was generated but never marked printed, so its lots stay Generated and QC correctly refuses them; no code or data defect, no record changed. Changes: the not-printed message now says the lot was generated but not marked printed and that the manufacturer operator must finish printing from Print orders or use Mark as printed (`src/lib/core/rules.ts`); the dev click-to-scan list on Verify offers printed lots, plus at most one unprinted lot labelled "not printed: expect rejection" (`src/lib/services/demo.ts`); print orders show *Printing pending* (codes generated, not marked printed) or *Printed* with date/time, a warning counts pending orders, and pending rows link "Finish printing" to the existing print view (`src/components/PrintOrderStatus.tsx` new, `operator/orders/page.tsx`, `PrintView.tsx`); guidance that Ctrl+P or the codes CSV does not record printing (`PrintView.tsx`, `GeneratedCodes.tsx`). Print confirmation itself unchanged: only Print / Mark as printed sets Printed, nothing on CSV export or browser print. New test `tests/unit/printConfirmation.test.ts`. | Lint, typecheck pass; unit JSON 350 passed + 1 skipped (25 files, incl. the 7 new tests); PostgreSQL (PGlite, `--no-file-parallelism`) 133 passed + 3 skipped (12 files, incl. the 7 new tests); production build and e2e 12/12 in an isolated copy (port 3100, own data); `data/db.json` and :3000 untouched |
| 30 Oct 2026 | Claude Code on `develop/aditya` | **Security and reliability fixes from the Phase 1–3 audit** (uncommitted). **F-01** a production build always requires sign-in; `SIGN_IN=off` is honoured only under `npm run dev` (`src/lib/signInMode.ts`). **F-02** `npm run seed` prints its target, refuses a store holding partners, batches, lots or history, and with `--force` first writes `db.backup-<time>-before-seed.json` (never overwrites one, read back before the reset); never replaces data in production; refused runs exit 1 (`src/lib/store/seedGuard.ts`, `scripts/seed.ts`). This follows the 15:44 IST `npm run seed` that wiped `data/db.json` (MF0001 "vietnam_mnf", batch X1SYQ7, 5,000 unprinted lots; no usable backup). Device names unique per plant (trimmed, spaces collapsed, any case; older look-alikes stay editable). **F-09** another manufacturer's code answers exactly like a never-generated code (reprint, QC scan; the QC scan log keeps the real reason, so no new counterfeit alerts); opening a lot checks location before status (`common.ts` `unknownCodeMessage`, `operator.ts`, `verify.ts`, `rules.ts` `canOpenLot`; recall is still reported wherever scanned). Readable validation messages with field-level details and no internal schema/table names (`src/lib/validationMessages.ts`, `api.ts` `errorResponse`, `admin.ts` not-found labels). UI: in-app delete confirmation dialog instead of the browser box (`ConfirmDialog.tsx`, `AdminCrud.tsx`); rejected inline edits show the stored value again; no `/api/auth/dev-users` request when sign-in is on (`ActAs.tsx`); larger targets on Print orders and Active checkboxes; readable partner-table fields at 1366 px; "1 retailer", "Lot 00006" / "Lots 00004–00006" (`src/lib/format.ts`). Audit corrections: device delete already returned RESERVED pool codes as RETURNED in the same transaction (finding withdrawn, now covered by tests); `ItemKind` vs movement kinds was already typed correctly (no change). New tests: `src/lib/signInMode.test.ts`, `src/lib/validationMessages.test.ts`, `tests/unit/seedSafety.test.ts`, `tests/unit/adminDevices.test.ts`, `tests/unit/disclosure.test.ts`. | In an isolated copy of the repo with its own data (never `data/db.json`, never :3000): lint, typecheck pass; unit JSON 343 passed + 1 skipped (24 files); PostgreSQL (PGlite) 126 passed + 3 skipped (11 files); production build + e2e 12/12; production build with `SIGN_IN=off` still requires sign-in; real `scripts/seed.ts` on scratch copies (refuse, --force + backup, bad path, production); browser checks 22/22 plus a clean console re-check; responsive 92 page/viewport checks: no overflow, sidebar drawer on tablet/phone, console errors 92 rows → only the expected sign-in-page 401 |
| 30 Oct 2026 | Claude Code on `develop/aditya` | **Batch continuation (Part 1, "Continuing a batch").** New print order → *Continue an existing batch*: lots carry on from the batch's persisted hex counter (one per batch) across days, operators, PCs and restarts. Reuses `nextLotNumber`, `allocateLots` and `formatLotNumber` (no second counter, no schema change). Online PCs of the same plant only; synced, not recalled, not exhausted, ≤ lots left, ≤ 10,000 lots per order (1,000 on JSON). Read-only preview; the created range is authoritative. Request key = print order ID (durable idempotency; replay must match plant, batch, cases, trays and PC). Exhausted is derived (`nextLot > 0x1869F`) and shown on Batches. Fixed two places that assumed one print order per batch (`listPrintOrders`, `codesForOrder`; output unchanged for existing orders; codes view "generated by" now the order's creator). Files: `src/lib/core/codes.ts`, `src/lib/services/printOrders.ts`, `src/lib/services/trace.ts`, `src/app/api/print-orders/continue/route.ts` (new), `src/app/(screens)/operator/new/page.tsx`, `src/app/(screens)/hq/batches/page.tsx`, `src/lib/core/codes.test.ts`, `tests/unit/continuation.test.ts` (new). | Lint, typecheck, build pass; unit JSON 306/306 (+1 skipped) in 19 files; PostgreSQL (PGlite, `--no-file-parallelism`) 103/103 (+1 skipped) in 8 files; continuation tests 26 per store, incl. two 10,000-lot orders on PGlite (28.7 s); e2e 12/12; HTTP smoke on a throwaway data copy (list, preview, create, replay, conflict 409, JSON cap 400, codes view, 401, 403). Continue screen not yet clicked through in a browser |
| 30 Oct 2026 | Claude Code on `develop/aditya` | **Sign-in temporarily off for testing (Part 5, "Sign-in temporarily off").** `.env.local`: `SIGN_IN=off`. While off, pages open without a cookie, `/login` → `/`, and API requests without a session act as the first active Velza Admin (no session, no write): `src/proxy.ts`, `src/lib/api.ts`, `src/lib/services/auth.ts` (`devDefaultUserId`), test in `tests/unit/registration.test.ts`. Sign-in code unchanged and these paths are inactive while on. Found: `data/db.json` re-seeded again at 10:38 IST (Partners 0), not restored; `npm start` reads `.env.local`. Docs: Part 1, key note 1, deployment caveats, Part 5, `docs/CRMS_STATUS.md`, `docs/MANUAL_SIGN_IN_TEST_GUIDE.md`. | Live :3000 off 24/24; production build off with restored copy 24/24 (18 partners, 21 sign-ins); on: API 583/584 + 639/640 (DEF-001), browser 309/309; `SIGN_IN` unset/empty/typo = on; lint, typecheck, build, e2e 12/12, unit JSON 250/250, PostgreSQL auth files 19/19 + 10/10; live data unchanged |
| 29 Oct 2026 | Claude Code on `develop/aditya` | **Partners (0) fixed (Part 5, "Partners (0) after a re-seed").** `data/db.json` had been re-seeded at 12:02 IST (0 partners, new Admin/HQ passwords). Backed up, then the 18 partners and 19 partner sign-ins restored from `data/qa-mh-2026.json`; new AD0001/HQ0001, session and settings kept. No code change. Docs: Part 5, `docs/CRMS_STATUS.md`, `docs/MANUAL_SIGN_IN_TEST_GUIDE.md`. | Live :3000: 19 partner sign-ins 579/580 (DEF-001); Admin/HQ service checks on a copy of live data; lint, typecheck; unit 249 (store contract's embedded-PostgreSQL hook times out with the dev server running — INFO-4 — passes 33/33 alone). Admin/HQ browser sign-in left to the user (new passwords) |
| 29 Oct 2026 | Claude Code on `develop/aditya` | **Sign-in switched on (Part 5).** No code change: `.env.local` (new, git-ignored) with `SIGN_IN=on`. `data/db.json` backed up, then the 18 QA partners and 19 sign-ins merged in (AD0001/HQ0001 untouched), 8 sessions from sign-in-off removed. Docs: Part 1 overview and connection notes, key note 1, Part 5, `docs/MANUAL_SIGN_IN_TEST_GUIDE.md` (new). Found AUTH-1 (sessions from sign-in-off survive switching on). | Lint, typecheck; unit 249/249 JSON, auth files on PostgreSQL; build + e2e 12/12; API checks 583/584 (partners, merged copy) and 89/90 (staff, QA copy), the misses being DEF-001; browser 309/309 (7 roles × 5 sizes) |
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
