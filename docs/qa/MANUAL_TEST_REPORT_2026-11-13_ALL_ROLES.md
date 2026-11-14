# Manual test report — all roles, full chain (13–14 Nov 2026)

| | |
|---|---|
| **Branch / code tested** | `features/barcode-history` at `91a27f2` (13 Nov); fixes in `cd843ef` (14 Nov) |
| **Tester** | Claude Code, driving Chrome through the Claude-in-Chrome extension, on the developer PC |
| **Build** | Production build (`next build` + `next start`) on port **3500** — not the dev server on :3000 |
| **Data** | A **copy** of `data/db.json` in a temporary folder (`VELZA_DB_PATH`), with test passwords set on the copy only. The live `data/db.json` and the :3000 dev server were not touched |
| **Sign-in** | Production builds always require sign-in, so each role was signed in with its own ID (the dev role switcher only exists in dev mode) |
| **Camera** | HP TrueVision HD webcam, 1280×720 |
| **Result** | Whole chain works for every role. **5 issues found** (4 bugs + 1 wording issue), all **fixed in `cd843ef` and re-verified** in the browser |

## 1. Flow test (13 Nov): Velza Warehouse → Distributor → Retailer, product details at each step

Set-up through the API (manufacturer side): print order marked printed, 2 cases QC-verified, loaded into container `MSCU7654321`, dispatched to the Velza Warehouse.

| Step | Role | Result |
|---|---|---|
| Receive container by scanning its number | Velza Warehouse | ✅ 2 cases → AT_WAREHOUSE |
| Dispatch case `913XIGAXMN00003` | Warehouse → Pune Distributor | ✅ |
| Product details | Warehouse | ✅ chain MF → Warehouse (you), "in transit to Distributor" |
| Receive, then dispatch | Distributor → Pune Retailer | ✅ AT_DB, then sent |
| Product details | Distributor | ✅ chain MF → Warehouse → Distributor (you) |
| Receive | Retailer | ✅ AT_RETAILER |
| Product details (pack `913XIGAXMN0000361`) | Retailer | ✅ batch, Mfg/Exp date, flavour, "came from" (SS "—", DB, Warehouse), full chain with invoices |

Note: the set-up script first sent 6 packs per case instead of 4, which quarantined 2 test cases **on the copy only**; QC behaved correctly.

## 2. Full manual test (13 Nov): every page of every role

| Role | Pages | What was done | Result |
|---|---|---|---|
| Manufacturer Operator | 9 | New print order wizard (Green Apple, 3 cases + 1 tray = 22 stickers, batch S2L74K); print view (barcodes rendered); mark cases, then trays printed; Print orders list; Reprint (logged, same code); Void lot (old unprinted lot); Containers (open `TCNU4455667`, load 2 cases + 1 tray, pack code and duplicate refused, dispatch to Warehouse); Dispatch (only Velza Warehouse offered — correct); My stock; Product details; Damaged page | ✅ (bugs 1–3 found here) |
| Supervisor / QC | 3 | Verified 3 cases + 1 tray pack by pack; a pack from another case was refused; My stock; Product details | ✅ (wording issue 5 found here) |
| Velza Warehouse | 6 | Received the container by its number (second scan refused: DUPLICATE_RECEIPT), received case 3 separately; dispatched to Super Stockist, Distributor and Retailer (sai mart) directly; My stock; Product details; Damaged; later inspected a return → back to stock | ✅ |
| Super Stockist | 6 | Received (a case addressed to the Distributor refused: WRONG_RECEIVER); My partners; dispatched to Distributor; My stock; Product details hides a code that never passed through it ("Unknown code … has not been at your location") | ✅ |
| Distributor | 6 | Received from both the Warehouse and the Super Stockist; My retailers; dispatched 2 cases to the Retailer; My stock; Damaged | ✅ |
| Retailer (Pune Retailer, sai mart) | 5 | Received; opened a case (4 packs counted); reported a damaged pack with a barcode photo + damage photo; My stock; Product details: full 5-step chain, and 3 steps for the tray sent direct from the Warehouse | ✅ |
| Velza Field Staff | 1 | Scanned a retailer pack (full chain), took it back ("Not selling"); the Warehouse received and restocked it | ✅ |
| Velza HQ | 7 | Dashboard (lot/pack counts add up: 110 lots, 546 packs); search with full timeline; alerts (damage photos shown; acknowledged one); scan audit; batches & recall (recalled S2L74K: recalled case refused at dispatch with BLOCKED_CODE; public page `/t/<code>` shows "Recalled — do not consume"); containers; product details | ✅ |
| Velza Admin | 7 | Partners, Sign-ins, Devices, Countries & flavours, Batch code pools, Settings, Product details all load; registered a new partner (RT0003) | ✅ (bug 4 found here) |
| Every role | Account | Account page loads with change-password form | ✅ |

### Camera

| Check | Result |
|---|---|
| Opens on the first click on every scan page (Reprint, Void, Containers, Dispatch, Receive, Product details, QC, Field scan) | ✅ live 1280×720 picture |
| Closing releases the webcam | ✅ track state "ended", preview removed |
| Barcode decoding | ✅ verified through the Damaged page photo upload (same zxing reader): a generated Code 128 image of `91S2L74KGA0000164` was read and matched. A physical barcode could not be held in front of the webcam during automated testing |

## 3. Issues found and fixed

| # | Issue (13 Nov) | Cause | Fix (`cd843ef`) |
|---|---|---|---|
| 1 | **Dispatch:** while typing the invoice number, the scan box appeared after the first letter and took the cursor; the rest of the invoice went into the scan box ("…is not a Velza code") | `src/components/ScanInput.tsx:123` focused the box whenever it appeared | The scan box takes focus only if no other field is being typed in |
| 2 | **Print view:** after marking cases printed (cases before trays) it warned "3 voided or recalled lot(s) of this order are not printed", logged "3 voided/recalled lot(s) withheld" in the audit trail, and the header showed 7 stickers instead of 22 | `src/lib/services/printOrders.ts:763-764` counted every lot no longer GENERATED (i.e. already printed) as withheld | Withheld = VOID or RECALLED only; the title counts the whole order |
| 3 | **Containers:** "All containers" showed 0 / 2,860 while 3 items were loaded; it only caught up after dispatch | Load / take-out reloaded only the open container panel | Load and take-out refresh the list too (`src/app/(screens)/containers/page.tsx`) |
| 4 | **Register partner:** "Address is required" appeared below the Register button and was easy to miss; State was also required by the server but not marked | No client-side required-field check | Required fields marked `*` (State too, except for the plant); errors under each field and above the button; first missing field scrolled into view and focused (`src/app/(screens)/admin/partners/page.tsx`) |
| 5 | **Plant stock wording:** "105 lot(s) awaiting QC" for lots that were not printed yet | `pendingCounts` counted GENERATED and PRINTED together | New `awaitingPrint` (GENERATED) → "N lot(s) not printed yet"; `awaitingQc` = PRINTED only (`src/lib/services/trace.ts`, stock and HQ pages) |

## 4. Re-verification (14 Nov) — fresh copy of the data, rebuilt app on :3500

| # | How it was re-tested in the browser | Result |
|---|---|---|
| 1 | Operator and Warehouse Dispatch: chose the destination, clicked the invoice box and typed "TEST-VW-INV-555" / "TEST-VW-DB-001" key by key | ✅ Whole invoice stayed in the invoice box, scan box empty; scanning still works and keeps the cursor; Receive and Product details still open with the cursor in the scan box |
| 2 | New order (Original, 3 cases + 1 tray), print view, marked cases printed, then trays | ✅ No "voided or recalled" warning, header "22 stickers" throughout; audit notes "22 sticker(s) of 4 lot(s)…" and "7 sticker(s) of 1 lot(s)…" with no withheld note |
| 3 | Opened container `TCNU1112223`, loaded 1 → 3 items, took one out | ✅ "All containers" showed 1 → 3 → 2, matching the open container |
| 4 | Registered a retailer with Address and State left empty | ✅ "Address is required" and "State is required" under the fields, summary above the button, Address scrolled into view and focused; after filling them, RT0003 registered |
| 5 | Operator → My stock | ✅ "Not counted as stock yet: 106 lot(s) not printed yet" |

### Automated checks (14 Nov)

| Check | Result |
|---|---|
| New regression test for issue 2 (`tests/unit/serialIntegrity.test.ts`, "cases printed first, then trays…") | Fails on the old code ("expected 3 to be 0"), passes with the fix |
| `tests/unit/traceFlow.test.ts` updated for issue 5 | Passes |
| Full unit suite (`npx vitest run`, JSON + PGlite) | 880 passed, 9 skipped |
| `npm run typecheck`, ESLint on changed files | Clean |
| Playwright end-to-end (`npx playwright test`) | 20 / 20 passed (incl. camera tests) |
| Re-run on the committed code `cd843ef` (14 Nov) | `serialIntegrity` + `traceFlow`: 91 passed, 3 skipped; typecheck clean |

## 5. Observations (not bugs)

- After fix 1, staff click (or tap) the scan box after typing the invoice before scanning — the box no longer grabs the cursor while another field is in use.
- During one test, Chrome's "suggest a strong password" pop-up swallowed keystrokes in a new-password field; re-typing worked. This is browser behaviour, not the app.
- The dev server on :3000 runs code started before these fixes; restart it to see them.

## 6. Branches

The fixes are on `features/barcode-history` only (`cd843ef`). `develop/aditya` (which has the self sign-up feature, `42ae268`) does **not** contain them; bring them across when the branches are merged (fix 4 overlaps the self sign-up changes to the Admin Partners page and needs a manual merge).
