# Customs Clearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MF ships containers to Customs (the existing Velza Warehouse partner, relabelled "Customs (Velza)"); goods received there are held (`AT_CUSTOMS`) until the Velza person clears the container; cleared stock (`AT_WAREHOUSE`) goes to Super Stockists only.

**Architecture:** One new item status and one new container status, decided in the pure rules layer (`src/lib/core/rules.ts`) and applied by the services (`containers.ts`, `movement.ts`). Receiving at Customs goes through a per-method resolver map (container / lot; pallet later), gated by a setting. PostgreSQL schema v8; the JSON store needs no migration.

**Tech Stack:** Next.js 16, TypeScript, zod, Vitest (projects `json` and `postgres`/PGlite), Playwright e2e, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-11-16-customs-clearance-design.md`

## Global Constraints

- Branch `feature/all-latest-integration`. **No `git commit` and no `git push`** until the user explicitly permits — every "Commit" step below is replaced by a checkpoint.
- Never touch `data/db.json` or the user's dev server on :3000. Browser tests: production build on :3500 with a COPY of `data/db.json` in the scratchpad.
- Internal names stay: partner type/role `WAREHOUSE`, ID prefix `VW`, status `AT_WAREHOUSE`. Only labels change: "Velza Warehouse" → **"Customs (Velza)"**; `AT_CUSTOMS` → "At customs — awaiting clearance"; `AT_WAREHOUSE` → "Cleared at customs".
- `SCHEMA_VERSION = 8`; every schema statement idempotent; `db/schema.sql` regenerated with `npm run db:schema`.
- Bill of Entry: optional, trimmed, ≤ 40 chars.
- `customsReceiveModes` default `["CONTAINER", "LOT"]`.
- Record the change in `WORKING_MODEL.md` (change-log row newest first + affected Part 1 sections). Keep line endings as the file has them.
- RAM is tight (~1 GB free): run one heavy job (build, e2e, PGlite suite) at a time, PGlite with `--no-file-parallelism`.

## Review Focus

1. A loose lot already in transit to Customs at go-live (no container) must arrive `AT_WAREHOUSE`, never stuck in `AT_CUSTOMS` → test in Task 3.
2. Container scan after some of its lots were received one by one must receive the rest, not answer `DUPLICATE_RECEIPT` → test in Task 3.
3. A damaged or recalled lot in a container being cleared must stay as it is (not become `AT_WAREHOUSE`) → test in Task 4.
4. A lot held `AT_CUSTOMS` must still be reportable as damaged and recallable at Customs → test in Task 4.
5. A return arriving at Customs with `customsReceiveModes = ["CONTAINER"]` must still be received (as `RETURNED`) → test in Task 3.

---

### Task 1: Core types and rules

**Files:**
- Modify: `src/lib/core/types.ts` (statuses, container, movement type, settings, labels)
- Modify: `src/lib/core/rules.ts` (destinations, receive patch, dispatch checks, public statuses, reject codes)
- Modify: `src/lib/core/permissions.ts` (`customsClear`)
- Modify: `src/lib/services/trace.ts:47` (`SELLABLE_STATUSES` + `AT_CUSTOMS`)
- Test: `src/lib/core/rules.test.ts`, `src/lib/core/publicSafety.test.ts`

**Interfaces:**
- Produces:
  - `ItemStatus` gains `"AT_CUSTOMS"` (in `MAIN_STATUSES`, after `IN_TRANSIT`).
  - `CONTAINER_STATUSES = ["LOADING", "IN_TRANSIT", "RECEIVED", "CLEARED"]`.
  - `Container` gains `clearedAt: string | null; clearedBy: string | null; billOfEntry: string | null`.
  - `MOVEMENT_TYPES` gains `"CUSTOMS_CLEARED"`.
  - `CUSTOMS_RECEIVE_MODES = ["CONTAINER", "LOT"] as const` (comment: `"PALLET"` later); `type CustomsReceiveMode`; `Settings.customsReceiveModes?: CustomsReceiveMode[]`; `DEFAULT_SETTINGS.customsReceiveModes = ["CONTAINER", "LOT"]`.
  - `RejectCode` gains `"NOT_CLEARED" | "CONTAINER_REQUIRED" | "RECEIVE_MODE_OFF"`.
  - `DESTINATION_TYPES.WAREHOUSE = ["SS"]`.
  - `receivePatch(receiver: Partner, fromStatus?: ItemStatus, opts?: { cleared?: boolean })` — at a `WAREHOUSE` receiver a non-return gives `AT_CUSTOMS` unless `opts.cleared`, then `AT_WAREHOUSE`; returns still `RETURNED`; other tiers unchanged.
  - `inStockStatuses(type: PartnerType): ItemStatus[]` — `WAREHOUSE` → `["AT_CUSTOMS", "AT_WAREHOUSE"]`, else `[AT_STATUS[type]]`.
  - `canDispatchLoose(receiver: Pick<Partner, "type" | "name">): RuleResult` — `CONTAINER_REQUIRED` when `receiver.type === "WAREHOUSE"`, message `Cases and trays go to ${receiver.name} in a container — use Containers`.
  - `canDispatch`: an item `AT_CUSTOMS` at a `WAREHOUSE` sender → `NOT_CLEARED`, message `${code} is awaiting customs clearance — clear its container first` (checked before the `AT_STATUS` comparison).
  - `PUBLIC_GENUINE_STATUSES` includes `AT_CUSTOMS`; `SELLABLE_STATUSES` includes `AT_CUSTOMS`.
  - `PERMISSIONS.customsClear = ["WAREHOUSE"]` (add `"customsClear"` to `ACTIONS`).
  - Labels: `PARTNER_TYPE_LABELS.WAREHOUSE` and `ROLE_LABELS.WAREHOUSE` = `"Customs (Velza)"`; status labels map (wherever `AT_WAREHOUSE` is labelled) gets `AT_CUSTOMS: "At customs — awaiting clearance"`, `AT_WAREHOUSE: "Cleared at customs"`.
  - Update the doc comment above `DESTINATION_TYPES` to the new chain (MF → Customs → SS → DB → Retailer).

- [ ] **Step 1: Write the failing tests** in `src/lib/core/rules.test.ts` (replace the existing WAREHOUSE-destination expectations at lines ~72–84):
  - `it("Customs dispatches only to SS")`: `canDispatch({ ...base, sender: VW, receiver: SS1, item: lot({ status: "AT_WAREHOUSE", locationId: "vw" }) })` → `{ ok: true }`; receivers `DB1`, `RT1` → `{ code: "WRONG_DESTINATION", message: /WAREHOUSE can only dispatch to SS/ }`.
  - `it("held stock cannot leave Customs")`: item `AT_CUSTOMS` at vw → `{ ok: false, code: "NOT_CLEARED" }`.
  - `it("receiving at Customs holds, unless cleared; returns unchanged")`: `receivePatch(VW).status === "AT_CUSTOMS"`; `receivePatch(VW, "IN_TRANSIT", { cleared: true }).status === "AT_WAREHOUSE"`; `receivePatch(VW, "RETURN_IN_TRANSIT").status === "RETURNED"`; `receivePatch(SS1).status === "AT_SS"`.
  - `it("loose dispatch to Customs needs a container")`: `canDispatchLoose(VW)` → `{ code: "CONTAINER_REQUIRED" }`; `canDispatchLoose(SS1)` → `{ ok: true }`.
  - `it("in-stock statuses")`: `inStockStatuses("WAREHOUSE")` equals `["AT_CUSTOMS", "AT_WAREHOUSE"]`; `inStockStatuses("SS")` equals `["AT_SS"]`.
  - In `publicSafety.test.ts`: `AT_CUSTOMS: { label: "Genuine Velza product", tone: "ok" }`.

- [ ] **Step 2: Run, expect FAIL**
  Run: `npx vitest run --project json src/lib/core`
  Expected: FAIL (AT_CUSTOMS unknown, receivePatch gives AT_WAREHOUSE, inStockStatuses/canDispatchLoose not defined).

- [ ] **Step 3: Implement** the Interfaces above in `types.ts`, `rules.ts`, `permissions.ts`, `trace.ts`.

- [ ] **Step 4: Run, expect PASS** — same command; then `npm run -s typecheck` (expect errors only in services/UI that later tasks fix; note them).

- [ ] **Step 5: Checkpoint** — no commit (user permission required).

### Task 2: PostgreSQL schema v8

**Files:**
- Modify: `src/lib/store/sql/schema.ts` (version, comment, container table, checks, index, upgrade section)
- Modify: `src/lib/store/sql/sqlStore.ts:214-233` (container columns)
- Regenerate: `db/schema.sql` (`npm run db:schema`)
- Test: `src/lib/store/store.contract.test.ts:420`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `SCHEMA_VERSION = 8`; `CODE_STATUS_CHECK` includes `'AT_CUSTOMS'`; new `const CONTAINER_STATUS_CHECK = "status IN ('LOADING', 'IN_TRANSIT', 'RECEIVED', 'CLEARED')"` used in `CREATE TABLE containers` and in the upgrade (`ALTER TABLE containers DROP CONSTRAINT IF EXISTS containers_status_check, ADD CONSTRAINT containers_status_check CHECK (...)`); columns `cleared_at timestamptz, cleared_by text, bill_of_entry text` (in CREATE TABLE and `ADD COLUMN IF NOT EXISTS` in a new `-- v8: customs clearance` section); `DROP INDEX IF EXISTS containers_one_active_per_code; CREATE UNIQUE INDEX containers_one_active_per_code ON containers (container_code) WHERE status IN ('LOADING', 'IN_TRANSIT')`; `CREATE INDEX IF NOT EXISTS containers_by_receiver ON containers (to_partner_id)`. sqlStore maps `clearedAt`→`cleared_at` (ts), `clearedBy`→`cleared_by`, `billOfEntry`→`bill_of_entry`.
- Header comment: add `// v8 (16 Nov 2026): customs clearance — code status AT_CUSTOMS, container status CLEARED + cleared_at/cleared_by/bill_of_entry; a cleared container's number can be reused.`

- [ ] **Step 1: Write the failing test** — contract test: `expect(await sql("SELECT version FROM schema_info")).toEqual([{ version: 8 }])` (comment `v8: customs clearance`); add `it("allows AT_CUSTOMS and CLEARED, reuses a cleared container number")`: insert a lot with status `AT_CUSTOMS` succeeds; a container `CLEARED` with code X plus a new `LOADING` container with code X both insert.
- [ ] **Step 2: Run, expect FAIL**: `npx vitest run --project json src/lib/store/store.contract.test.ts`
- [ ] **Step 3: Implement** schema/sqlStore changes; run `npm run db:schema`.
- [ ] **Step 4: Run, expect PASS** — same command, plus `npx vitest run --project json src/lib/store/sql/schema.test.ts` (schema file in sync).
- [ ] **Step 5: Upgrade check** — scratch script (scratchpad, not in repo) applying `git show HEAD:db/schema.sql` (v7) to an in-memory PGlite, then current `SCHEMA_SQL` twice. Expected: version 8, `cleared_at` column exists, a `CLEARED` container inserts.
- [ ] **Step 6: Checkpoint** — no commit.

### Task 3: Receiving at Customs

**Files:**
- Create: `src/lib/services/customs.ts` (resolver map, mode check, container-of-lot lookup)
- Modify: `src/lib/services/containers.ts:216-250` (`receiveContainer`)
- Modify: `src/lib/services/movement.ts:125-148` (`receiveItem`), `:187-215` (`receive`)
- Test: Create `tests/unit/customs.test.ts`

**Interfaces:**
- Consumes: Task 1 `receivePatch(..., { cleared })`, `CUSTOMS_RECEIVE_MODES`; Task 2 columns.
- Produces (in `customs.ts`):
  - `containerOfLot(tx: StoreTx, receiverId: string, lotCode: string): Promise<Container | null>` — the container sent to `receiverId` (status `IN_TRANSIT`, `RECEIVED` or `CLEARED`, via `tx.containers.list({ toId: receiverId })`) whose `lotCodes` includes `lotCode`; latest `dispatchedAt` wins.
  - `receiveModeAllowed(settings: Settings, mode: CustomsReceiveMode): boolean` — uses `settings.customsReceiveModes ?? DEFAULT_SETTINGS.customsReceiveModes`.
  - `RECEIVE_MODE_OFF_MESSAGE: Record<CustomsReceiveMode, string>` — CONTAINER: `"Customs receives case by case — scan each case or tray"`, LOT: `"Customs receives whole containers — scan the container number"`.
  - Comment block: "Pallets: add `PALLET` to CUSTOMS_RECEIVE_MODES and a pallet → lots resolver here; holding, clearing and dispatch work on lots and need no change."
- Behaviour changes:
  - `receiveItem`: when `receiver.type === "WAREHOUSE"` and the item is not a return, `cleared = !container || container.status === "CLEARED"` where `container = await containerOfLot(...)` for the item's lot code; passes `{ cleared }` to `receivePatch`. If the container is `IN_TRANSIT`, update it to `RECEIVED` (`receivedAt`, `receivedBy`).
  - `receive`: at a WAREHOUSE receiver, a lot/pack scan (not a return, i.e. item status ≠ `RETURN_IN_TRANSIT`) is refused with `RECEIVE_MODE_OFF` when mode `LOT` is off; a container scan is refused with `RECEIVE_MODE_OFF` when mode `CONTAINER` is off. Both logged via `logScan`.
  - `receiveContainer`: also matches a `RECEIVED` container to this receiver that still has lots `IN_TRANSIT` to it → receives those; `DUPLICATE_RECEIPT` only when none remain (and for `CLEARED` with none remaining). Message: `Container ${code} received: ${n} case(s)/tray(s) → At customs, awaiting clearance` (or `→ Cleared at customs` when the container is `CLEARED`); return `status` is the status given.

- [ ] **Step 1: Write the failing tests** (`tests/unit/customs.test.ts`, both stores via the existing test setup used by `containers.test.ts`; ship with the container API):
  - `container scan → every lot and its packs AT_CUSTOMS; container RECEIVED`
  - `lot scan → AT_CUSTOMS and its container becomes RECEIVED`
  - `container scan after one lot was received alone → receives the rest (received: n-1), not DUPLICATE_RECEIPT`
  - `second container scan with nothing left → DUPLICATE_RECEIPT`
  - `loose lot already in transit to Customs (dispatched before go-live: create it by writing the IN_TRANSIT state through the store) → AT_WAREHOUSE` (Review Focus 1)
  - `customsReceiveModes ["CONTAINER"] → lot scan RECEIVE_MODE_OFF; ["LOT"] → container scan RECEIVE_MODE_OFF`
  - `a return arrives at Customs with modes ["CONTAINER"] → RETURNED` (Review Focus 5)
- [ ] **Step 2: Run, expect FAIL**: `npx vitest run --project json tests/unit/customs.test.ts`
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run, expect PASS** — same command.
- [ ] **Step 5: Checkpoint** — no commit.

### Task 4: Clearing a container

**Files:**
- Modify: `src/lib/services/containers.ts` (new `clearContainer`, `getContainer` adds received/total counts)
- Create: `src/app/api/containers/[id]/clear/route.ts` (POST, same pattern as `[id]/dispatch/route.ts`)
- Modify: `src/lib/services/damage.ts:27`, `src/lib/services/returns.ts:77` → use `inStockStatuses(...)` instead of `AT_STATUS[...]` equality
- Test: `tests/unit/customs.test.ts`

**Interfaces:**
- Consumes: Task 1 `PERMISSIONS.customsClear`, `inStockStatuses`; Task 3 receive.
- Produces: `clearContainerSchema = z.object({ billOfEntry: z.string().trim().max(40).optional() })`; `clearContainer(userId: string | null, id: string, body: unknown): Promise<{ ok: true; container: Container; cleared: number; notHere: number; message: string }>` — requires action `customsClear`, container `toId` = actor's partner (else `notFound`), status must be `RECEIVED` (`CLEARED` → `badRequest("ALREADY_CLEARED", ...)`, other → `badRequest("CONTAINER_NOT_RECEIVED", ...)`). Moves each of its lots that is `AT_CUSTOMS` at this partner (and their packs, via `setLotState`) to `AT_WAREHOUSE`, one movement each `{ type: "CUSTOMS_CLEARED", fromStatus: "AT_CUSTOMS", toStatus: "AT_WAREHOUSE", fromId: me, toId: me, invoice: container.invoice, note: billOfEntry ? "Bill of Entry " + billOfEntry : "Customs cleared" }`. Updates container `{ status: "CLEARED", clearedAt, clearedBy, billOfEntry: billOfEntry || null }`. Message: `Container ${code} cleared: ${cleared} case(s)/tray(s) ready to dispatch` + `(${notHere} not here or not held)` when > 0.
- `getContainer` adds `receivedCount` (lots of the container located at `toId`) and `total` (= `lotCodes.length`) for the "n of N received" label.

- [ ] **Step 1: Write the failing tests**:
  - `clear → lots and packs AT_WAREHOUSE, CUSTOMS_CLEARED movement with Bill of Entry note, container CLEARED with clearedBy`
  - `clear before receive → CONTAINER_NOT_RECEIVED; clear twice → ALREADY_CLEARED`
  - `SS / operator / HQ cannot clear (forbidden)`
  - `early clear: 1 of 3 received, clear, then container scan → the other 2 arrive AT_WAREHOUSE`
  - `a damaged lot in the container stays DAMAGED after clearing; notHere = 1` (Review Focus 3)
  - `a lot AT_CUSTOMS can be reported damaged and is recalled by a batch recall` (Review Focus 4)
  - `after clearing, Customs dispatches to SS ok; to DB → WRONG_DESTINATION`
  - `a cleared container's number can be used for a new container`
- [ ] **Step 2: Run, expect FAIL**: `npx vitest run --project json tests/unit/customs.test.ts`
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run, expect PASS**; then `npx vitest run --project postgres --no-file-parallelism tests/unit/customs.test.ts` (copy the file into the postgres project include if it lives under `tests/unit` — it does).
- [ ] **Step 5: Checkpoint** — no commit.

### Task 5: Plant ships to Customs only in containers

**Files:**
- Modify: `src/lib/services/movement.ts` (`dispatch`: after the header check, `canDispatchLoose(receiver)`; on failure `badRequest` for confirm and `{ ok: false, ... }` for check, same shape as header failures)
- Modify: `src/lib/menu.ts:33` (remove `dispatch` from OPERATOR; update Containers/Warehouse descriptions to "Customs")
- Create: `tests/fixtures/shipToCustoms.ts`
- Modify (migrate loose MF→VW dispatch to the helper): `tests/unit/damage.test.ts`, `demoScript.test.ts`, `quarantine.test.ts`, `scanWorkflows.test.ts`, `serialIntegrity.test.ts`, `traceFlow.test.ts`, `returns.test.ts`, `containers.test.ts`, `productDetails.test.ts`, `maharashtraDataset.test.ts`, `scalability.test.ts`, `signup.test.ts` (only those that dispatch MF → VW or expect VW → DB/RT); `tests/fixtures/sampleNetwork.ts`; `tests/qa/qaRun.ts`; `src/lib/services/demo.ts`
- Test: `tests/unit/containers.test.ts`

**Interfaces:**
- Produces: `shipToCustoms(opts: { operatorId: string; customsUserId: string; customsId: string; lotCodes: string[]; invoice: string; containerCode?: string; clear?: boolean }): Promise<string>` — creates, loads, dispatches the container, receives it by container scan, and (default `clear: true`) clears it; returns the container id. Default `containerCode` is a unique valid code per call (e.g. `"TCSU" + counter padded to 7`).
- Tests that exercise the *dispatch screen* mechanics with the operator as sender (`scanWorkflows.test.ts`, `demoScript.test.ts` dispatch checks, `quarantine.test.ts`) switch sender to Customs → SS on cleared stock, keeping each assertion's intent (invoice required, all-or-nothing, race, quarantine refusal).

- [ ] **Step 1: Write the failing test** in `containers.test.ts`: `loose dispatch MF → Customs is refused`: `dispatch(ids.operator, { action: "check", toPartnerId: ids.VW, invoice: "X", code })` → `{ ok: false, code: "CONTAINER_REQUIRED" }`; `confirm` rejects with `CONTAINER_REQUIRED`.
- [ ] **Step 2: Run, expect FAIL**: `npx vitest run --project json tests/unit/containers.test.ts`
- [ ] **Step 3: Implement** the rule, the helper and the migrations.
- [ ] **Step 4: Run the whole JSON suite, expect PASS**: `npx vitest run --project json` — every failure must be a test still using loose MF→VW or expecting VW→DB/RT / AT_WAREHOUSE-on-receive; fix by migrating, never by loosening the rule.
- [ ] **Step 5: Checkpoint** — no commit.

### Task 6: Settings and screens

**Files:**
- Modify: `src/lib/services/admin.ts:515` (`settingsSchema.customsReceiveModes: z.array(z.enum(CUSTOMS_RECEIVE_MODES)).min(1)`)
- Modify: `src/lib/validationMessages.ts` (`customsReceiveModes: "Customs receives by"`)
- Modify: `src/app/(screens)/admin/settings/page.tsx` ("Customs receives by": checkboxes "Container number", "Case / tray"; at least one required)
- Modify: `src/app/(screens)/containers/page.tsx` (status column Received/Cleared; for a WAREHOUSE user a RECEIVED container shows "n of N received", Bill of Entry input, **Mark cleared** → `POST /api/containers/{id}/clear`; detail shows cleared date, by whom, Bill of Entry)
- Modify: `src/app/(screens)/stock/page.tsx` + its API (Customs: separate counts "Awaiting clearance" / "Cleared — ready to dispatch")
- Modify: `src/app/(screens)/dispatch/page.tsx:43` (filter `inStockStatuses`-aware: Customs lists only `AT_WAREHOUSE`, i.e. keep `AT_STATUS` there — confirm the receiver dropdown shows SS only via `DESTINATION_TYPES`)
- Modify: `src/app/(screens)/receive/page.tsx` (Customs hint text from the setting)
- Modify: `src/components/ui.tsx:153` (badge tone `AT_CUSTOMS: "warn"`)
- Modify: every UI text "Velza Warehouse" → "Customs (Velza)" (`grep -rn "Velza Warehouse" src`), incl. partners page and sign-up text
- Test: `tests/unit/customs.test.ts` (settings), e2e `tests/e2e/demo.spec.ts`

**Interfaces:**
- Consumes: Task 4 `clearContainer` route and `getContainer` counts; Task 3 modes.

- [ ] **Step 1: Write the failing test**: `updateSettings(admin, { customsReceiveModes: [] })` rejects; `{ customsReceiveModes: ["CONTAINER"] }` saves and a following lot scan at Customs gives `RECEIVE_MODE_OFF`.
- [ ] **Step 2: Run, expect FAIL**: `npx vitest run --project json tests/unit/customs.test.ts`
- [ ] **Step 3: Implement** the settings and screen changes.
- [ ] **Step 4: Run, expect PASS**; `npm run -s typecheck` and `npx eslint` clean.
- [ ] **Step 5: Update the e2e demo** (`tests/e2e/demo.spec.ts`): MF ships to Customs by container only (replace the loose offline-lot dispatch to VW-1); receive shows "At customs, awaiting clearance"; Customs clicks Mark cleared with Bill of Entry `BE-1234567`; Customs dispatches to an SS; the receiver dropdown has no DB/RT. Run: `npx next build` then `npx playwright test` (one at a time). Expected: all pass.
- [ ] **Step 6: Checkpoint** — no commit.

### Task 7: Working model, full verification, live walkthrough, report

**Files:**
- Modify: `WORKING_MODEL.md` (change-log row 16 Nov at the top; Part 1 overview chain, statuses table, "Velza Warehouse and shipping containers" section → Customs, workflow, roles)
- Modify: `docs/superpowers/specs/2026-11-16-customs-clearance-design.md` (index note: containers found via `to_partner_id` index, not a GIN index on `lot_codes`)

- [ ] **Step 1: Update `WORKING_MODEL.md`** per the spec.
- [ ] **Step 2: Full verification, one at a time**: `npm run -s typecheck`; `npx eslint`; `npx vitest run --project json`; `npx vitest run --project postgres --no-file-parallelism`; `npx next build`; `npx playwright test`. Expected: all green; record counts.
- [ ] **Step 3: Live walkthrough** on a production build at `127.0.0.1:3500` with a COPY of `data/db.json` in the scratchpad (test passwords on the copy only): Operator creates/loads/dispatches a container to VW0001 → Customs scans container → stock shows awaiting clearance, dispatch refuses → Mark cleared with Bill of Entry → dispatch to SS0001 works, DB/RT not offered → SS receives. Screenshots to scratchpad. Stop the server afterwards.
- [ ] **Step 4: Report to the user**: what changed, test counts, walkthrough result, open points (SS/DB/RT request screens, pallets, receiving method decision, rules awaiting Velza approval). No commit, no push.
