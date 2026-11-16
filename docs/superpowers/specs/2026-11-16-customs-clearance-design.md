# Customs clearance — design

16 Nov 2026 · branch `feature/all-latest-integration` · status: **draft, awaiting approval** (not committed)

## Intent

Velza's pipeline changed. The plant (MF) no longer ships to a separate warehouse: it ships containers to **Customs**.
A Velza person works at Customs. After customs clearance that person distributes cases and trays to **Super
Stockists**, as each SS needs. Customs and the Velza Warehouse are the same place (user, 16 Nov).

New chain: **MF → Customs (Velza person) → SS → DB → Retailer** (SS → Retailer direct stays allowed).

Why the system must change: today stock received at the warehouse can be sent on at once and to any SS, DB or
Retailer. Under the new pipeline goods must not move until customs has cleared them, and may only go to an SS.

## Goals

1. Goods received at Customs are **held** ("At customs — awaiting clearance") and cannot be dispatched.
2. The Velza person **clears a container**; every case/tray of that container that has arrived becomes available.
3. From Customs, goods go **only to SS**.
4. How goods are scanned in at Customs is **not decided yet** (container number, pallet, or each case/tray). The system
   must make switching between these a setting change, not a code change, and must not need rework when pallets come.
5. The hold is visible wherever a code shows: scan results, stock, HQ trace/search, product details, public check page.

## Non-goals (this change)

- **Requirement requests** from SS (and later DB / Retailer) to Customs. Wanted later; the request screen is a
  separate decision (user, 16 Nov). For now the Velza person decides what each SS gets, outside the system.
- **Pallets**: no pallet label, pallet creation or pallet scan yet (format and who builds pallets are undecided).
- Customs holds, rejections, duties, inspections by the customs authority, or partial clearance of a container.
- Several Customs points. One exists (VW0001); more remain registrable as today without code changes.

## Anti-goals

- Stock already at the warehouse in live data must **not** become stuck behind a clearance it never needed.
- Existing IDs (VW0001, sign-in VW0001), routes and stored data keep working — no renumbering, no data rewrite.
- No change to the plant's container loading/dispatch (other than blocking loose dispatch to Customs, below) or to
  anything after SS.

## Constraints

- Two stores (JSON file, PostgreSQL) behind one `Store` contract; PostgreSQL schema is versioned (`SCHEMA_VERSION`,
  currently 7) and re-applied idempotently when the stored version differs.
- Code status values are enforced by a PostgreSQL CHECK (`CODE_STATUS_CHECK`); container status likewise.
- Every change is recorded in `WORKING_MODEL.md` (change log row + affected sections).
- Scale target 100 crore barcodes/year: no new per-code column; clearing a container updates only its own lots/packs.

## Approaches considered

| | Approach | Trade-off | |
|---|---|---|---|
| **A** | New code status `AT_CUSTOMS` (awaiting clearance); clearance moves lots/packs to existing `AT_WAREHOUSE`, shown as "Cleared at customs" | Hold is visible everywhere a status shows; dispatch rules already work off status. Cost: one new status in lists, labels, schema check (v8) | **Chosen** (user, 16 Nov) |
| B | Keep `AT_WAREHOUSE`; container gets a "cleared" flag; dispatch looks up the container | No new status, but a held case looks shippable in stock/trace; extra lookup per dispatch | Rejected |
| C | Boolean `customsCleared` on every code | Widens the biggest table; duplicates what status expresses | Rejected |

## Design

### Names

- Partner type / role `WAREHOUSE` keeps its internal name and the `VW` ID prefix. Its **label** becomes
  **"Customs (Velza)"** everywhere the UI shows "Velza Warehouse" (partner type, role, menus, page text, help).
- New item status **`AT_CUSTOMS`**, label "At customs — awaiting clearance".
- Existing status **`AT_WAREHOUSE`** keeps its value; label becomes **"Cleared at customs"**.

### The plant ships to Customs only in containers

The plain Dispatch screen no longer lets the plant (Operator) send loose cases/trays to a `WAREHOUSE` partner: refused
with `CONTAINER_REQUIRED` ("Cases and trays go to Customs in a container — use Containers"). The receiver list on the
plant's Dispatch screen is therefore empty of Customs; the Containers flow is unchanged. Reason: clearance is per
container, so a loose lot could never be cleared (user, 16 Nov: picked).

### Receiving at Customs (any method → same result)

Receiving at a `WAREHOUSE` partner puts the case/tray (and its packs) into **`AT_CUSTOMS`**, whatever was scanned:

| Method | Today | After |
|---|---|---|
| Container number | receives every case/tray of the container | same, → `AT_CUSTOMS` |
| One case/tray code | receives that lot | same, → `AT_CUSTOMS` |
| Pallet | — | **later**; plugs into the same receive path (see "Ready for pallets") |

**Exceptions — these go straight to `AT_WAREHOUSE`:**
- a lot whose container is already **CLEARED** (a straggler scanned after its container was cleared needs no second
  clearance);
- a lot that belongs to **no container** — only possible for loose lots already in transit to Customs on the day this
  goes live (go-live cut-over, user 16 Nov: picked). Containers in transit at go-live are held and cleared as normal.

**Mixed methods on one container:** scanning the container number after some of its lots were received one by one
receives the remaining in-transit lots (today this is refused as `DUPLICATE_RECEIPT`; it stays refused only when
nothing of the container is still in transit to this partner).

**Returns are unchanged:** a return arriving at Customs still becomes `RETURNED`, and inspection "back to stock"
still gives `AT_WAREHOUSE` — returned goods have already been through customs.

**Setting — which methods Customs may use:** `customsReceiveModes` in Settings (Admin → Settings), a list of
`CONTAINER`, `LOT` (later `PALLET`). Default `["CONTAINER", "LOT"]` = today's behaviour. A scan using a method that
is switched off is refused with a clear message (`RECEIVE_MODE_OFF`, e.g. "Customs receives whole containers — scan
the container number"). Returns are always accepted by lot scan regardless of the setting.

### Clearing a container

- Container statuses: `LOADING → IN_TRANSIT → RECEIVED → CLEARED` (new).
- On the Containers page, a `RECEIVED` container shows **Mark cleared** to the Customs user, with an optional
  **Bill of Entry number** (free text, trimmed, ≤ 40 chars). Records `clearedAt`, `clearedBy`, `billOfEntry`.
- Clearing moves every lot of that container that is `AT_CUSTOMS` at this Customs partner — and its packs — to
  `AT_WAREHOUSE`, with one movement per lot of new type **`CUSTOMS_CLEARED`** (fromStatus `AT_CUSTOMS`, toStatus
  `AT_WAREHOUSE`, note includes the Bill of Entry number when given). Lots of the container that are not there
  (not yet received, damaged, recalled …) are left alone and counted in the result message.
- **Clearing before everything has arrived is allowed** (customs clears the whole container's paperwork; user 16 Nov:
  picked). The button shows "n of N received" so it is a deliberate choice; lots received afterwards are cleared on
  arrival (straggler rule).
- A container can be cleared once; clearing a `CLEARED` container is refused (`ALREADY_CLEARED`); clearing one that
  isn't `RECEIVED` is refused (`CONTAINER_NOT_RECEIVED`).
- **Lot-scan receiving without a container scan:** the container's status moves to `RECEIVED` when its first lot is
  received at Customs, so "Mark cleared" is available in every receiving method.
- Permission `customsClear`: `WAREHOUSE` only. HQ (TRACE_OWNER) sees cleared/uncleared state on Containers but
  cannot clear.

### Dispatch from Customs

- `CAN_DISPATCH_TO.WAREHOUSE` becomes `["SS"]` (was SS, DB, RETAILER).
- Stock must be `AT_WAREHOUSE` (cleared) to be dispatched; an `AT_CUSTOMS` lot is refused with `NOT_CLEARED`
  ("… is awaiting customs clearance — clear container X first").
- Lots already at DB/RT from earlier direct shipments are unaffected.

### Status lists

| List | `AT_CUSTOMS` |
|---|---|
| Public check page (`PUBLIC_GENUINE_STATUSES`) | yes — "Genuine Velza product" |
| Sellable/stock counts (`SELLABLE_STATUSES`, stock page, demo stock) | counted as stock at Customs, shown separately as "awaiting clearance" |
| Damage report | allowed (as `AT_WAREHOUSE`) |
| Recall | applies (as any in-chain status) |
| HQ dashboard status counts, status badges (`ui.tsx`) | new entry |
| Not-received alerts | unchanged (they look at `IN_TRANSIT`) |

### Ready for pallets (seam, not built)

The receive path at a Customs partner resolves a scanned code to a **list of lots** through one function per method
(container → its lots, lot → itself). Pallets later add one resolver (pallet → its lots) plus `PALLET` in
`customsReceiveModes`; holding, clearing and dispatch need no change because they work on lots. What pallets will
still need when decided: pallet label/number format, who builds a pallet (plant or Customs), a pallets table.

### Data and schema

- Types: `ItemStatus` + `AT_CUSTOMS`; `ContainerStatus` + `CLEARED`; `Container` + `clearedAt`, `clearedBy`,
  `billOfEntry` (nullable); movement type + `CUSTOMS_CLEARED`; `Settings.customsReceiveModes`.
- PostgreSQL **schema v8**: code status check adds `AT_CUSTOMS`; container status check adds `CLEARED`; containers
  table adds three nullable columns (`code_history.event` has no check, so `CUSTOMS_CLEARED` needs no schema change).
  The unique index `containers_one_active_per_code` (today `WHERE status <> 'RECEIVED'`) becomes
  `WHERE status IN ('LOADING', 'IN_TRANSIT')` so a cleared container's number can be reused; the container of a
  lot is found among the containers sent to that Customs partner (index `containers_by_receiver` on `to_partner_id`;
  built 16 Nov instead of a GIN index on `lot_codes` — one Customs point receives few containers). All `IF NOT EXISTS` / check re-applied —
  idempotent; `db/schema.sql` regenerated. JSON store needs no migration (missing fields = null,
  missing setting = default).
- Existing data: lots already `AT_WAREHOUSE` stay as they are = cleared; `RECEIVED` containers stay `RECEIVED` (they
  can be marked cleared, which moves nothing because their lots are already `AT_WAREHOUSE`).

### Screens

- **Receive (Customs):** result line says "→ At customs — awaiting clearance"; hint text follows the setting.
- **Containers:** status column shows Received / Cleared; Received ones get "Mark cleared" + Bill of Entry box for
  Customs; detail view shows cleared date, by whom, Bill of Entry.
- **Dispatch (Customs):** receiver list shows SS only.
- **Stock (Customs):** separate counts "Awaiting clearance" and "Cleared — ready to dispatch".
- **Admin → Settings:** "Customs receives by" checkboxes: Container number, Case/tray.
- Labels: "Velza Warehouse" → "Customs (Velza)" (partner type, role, menu, sign-up text, partners page).

### Testing

- Unit (both stores): receive by container → AT_CUSTOMS; receive by lot → AT_CUSTOMS and container RECEIVED;
  straggler after clearance → AT_WAREHOUSE; dispatch of AT_CUSTOMS refused; clear → lots/packs AT_WAREHOUSE with
  movements and Bill of Entry; clear twice / before receive refused; dispatch Customs → DB/RT refused, → SS allowed;
  receive mode off refused; returns unaffected; permissions (only WAREHOUSE clears); public check shows genuine.
- Schema: v7 database upgrades to v8 (PGlite), contract test expects 8, `db/schema.sql` in sync.
- Existing suites updated where they assumed warehouse → DB/RT or receive → AT_WAREHOUSE.
- Full run: typecheck, lint, unit JSON + PGlite, e2e on JSON; a browser walk-through of MF → Customs → clear → SS on a
  production build at :3500 with a **copy** of `data/db.json` (user's :3000 server and data untouched).

## Decided by the user (16 Nov 2026)

- Customs and the Velza Warehouse are the same place (option A).
- Velza person decides distribution now; SS/DB/RT request screens later (separate decision).
- Hold modelled as a new status (approach A).
- Receiving method not fixed: keep container, pallet and case/tray all possible, easy to switch.
- Do not commit or push until the user permits; test first, then report.
- Plant ships to Customs only in containers (loose dispatch blocked).
- A container may be cleared before all of it has arrived; later arrivals are cleared on arrival; a later container
  scan receives the rest.
- Go-live: containers in transit are held; loose lots in transit skip the hold.
- These rules may change once Velza approvals come in (user, 16 Nov).

## My calls (correct any)

- Label "Customs (Velza)"; internal names `WAREHOUSE` / `VW` / `AT_WAREHOUSE` kept.
- Clearance is per whole container, one step, optional Bill of Entry number; no un-clear.
- Straggler lots of a cleared container skip the hold.
- Only the Customs user clears; HQ sees but doesn't clear.
- Receive-method setting defaults to container + case/tray (today's behaviour); returns ignore it.
- Pallets: seam only.
