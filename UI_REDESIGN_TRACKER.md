# UI Redesign Tracker

One row per existing screen. **Status:** ⬜ not started · 🟨 in progress · ✅ done and regression-checked.
"Protected hooks" are the ids, test ids, labels and texts the app or the tests depend on; they must survive the redesign unchanged.
Plan and rules: [UI_REDESIGN_AUDIT.md](UI_REDESIGN_AUDIT.md). Baseline: [UI_FUNCTIONALITY_BASELINE.md](UI_FUNCTIONALITY_BASELINE.md).

**Progress (20 Nov 2026):** the Stitch design system and shared shell are in, and the HQ dashboard is done. The work is awaiting approval and is not committed yet. See `docs/ui-redesign/stitch/hq-dashboard/IMPLEMENTATION-REPORT.md`. The other screens have the new tokens and shell but no screen-level redesign yet.

## Foundations

| Step | Item | Files | Status | Protected hooks |
|---|---|---|---|---|
| 1 | Tokens, status palette, type scale | `globals.css`, `layout.tsx` (fonts) | ✅ | `@media print` block, `dark:` and `sidebar-collapsed:` variants, `.theme-light/.theme-dark`, `.tabular` |
| 1 | Primitives | `ui.tsx`, `charts.tsx` | ✅ | `Card` = `<section>` + `h2`; `Field` wraps `<label>`; `Button` default `type="button"`; `Notice` roles (alert / status); prop names |
| 2 | Sidebar | `Sidebar.tsx` | ✅ | `#app-sidebar`, `#app-menu-button` ("Open menu"), `nav a[aria-current="page"]`, menu label texts, drawer focus trap / Escape / inert, `velza-sidebar` key |
| 3 | Header | `AppHeader.tsx` (`ThemeSwitcher.tsx` unchanged) | ✅ | `data-testid="signed-in-user"`, button "Sign out", theme radiogroup "Theme" with "Light/Dark/System theme", `velza-theme` key |
| 3 | Operator device bar | `DeviceBar.tsx` | ⬜ | `data-testid="device-bar"`, buttons /Online/, /Offline/, "Sync" (disabled state), text /Device is offline/ |

## Screens

| # | Screen | Route | Roles | Plan step | Status | Protected hooks |
|---|---|---|---|---|---|---|
| 1 | Overview | `/` | all | 7 | ⬜ | `MENU` labels and descriptions |
| 2 | Account | `/account` | all | 11 | ⬜ | labels "Current password", /^New password/, "Repeat new password"; button "Change password"; text "Password changed" |
| 3 | Sign in | `/login` | public | 11 | ⬜ | labels "Sign-in ID", "Password"; `name="loginId"`/`"password"`; button "Sign in"; link "Create an account" |
| 4 | Sign up | `/signup` | public | 11 | ⬜ | radio names start with type label; labels "Shop / business name", "Your name", "Place", "Address", "City", "State", "Phone", "Supplied by", "Password", "Repeat password"; button "Create account"; `signup-done`, `signup-login-id`; `data-field` |
| 5 | Public QR | `/t/[code]` | public | 11 | ⬜ | `public-status` |
| 6 | Partners | `/admin/partners` | ADMIN | 4, 10 | ⬜ | `data-field=name/contactPerson/place/address/city/state/phone`; `register-result`, `no-pending`, `pending-{id}`; aria-labels Tier, Show, Site name, Contact person, Place, Address, City, State, PIN code, Phone, Email, Assigned to tier, Assigned to; first column = ID; `section` "Register a partner" |
| 7 | Sign-ins & passwords | `/admin/users` | ADMIN | 4 | ⬜ | aria-labels Role, Partner, "New password"; AdminCrud row key |
| 8 | Devices | `/admin/devices` | ADMIN | 4 | ⬜ | AdminCrud column labels |
| 9 | Countries & flavours | `/admin/reference` | ADMIN | 4 | ⬜ | AdminCrud column labels |
| 10 | Batch code pools | `/admin/pools` | ADMIN | 4 | ⬜ | aria-label "Codes to issue"; button "Issue codes" |
| 11 | Settings | `/admin/settings` | ADMIN | 4 | ⬜ | `Field` label texts; button "Save settings" |
| 12 | HQ dashboard | `/hq` | TRACE_OWNER | 5 | ✅ Stitch | `returns-row` + `data-code`; stock row name /^Super Stockist SS-1/ (first cell = tier) |
| 13 | Search code | `/hq/search` | TRACE_OWNER | 5 | ⬜ | `#scan-input`; `search-result`, `search-location`, `timeline-row` (column 2 = Event) |
| 14 | Alerts | `/hq/alerts` | TRACE_OWNER | 12 | ⬜ | `alert-row`, `alert-photo`; chip `aria-pressed` |
| 15 | Batches & recall | `/hq/batches` | TRACE_OWNER | 12 | ⬜ | button "Report", "Recall batch {code}", /Yes, recall/; placeholder /Quality complaint/; `batch-report`, `recall-report` |
| 16 | Scan audit | `/hq/scans` | TRACE_OWNER | 12 | ⬜ | — |
| 17 | New print order | `/operator/new` | OPERATOR | 6 | ⬜ | `div.rounded-md` per-batch wrapper; spinbuttons "Number of batches", "Batch N cases/trays"; buttons "Next", "Create & print", "Open print view"; `summary-batch-N`, `summary-stickers-N`, `summary-total-stickers`, `continue-batch-{code}`, `continue-summary`, `continue-range`; step order |
| 18 | Print orders | `/operator/orders` | OPERATOR | 6 | ⬜ | link `a[href="/print/{id}"]` "Finish printing"; "PRINTING PENDING" |
| 19 | Order codes | `/operator/orders/[id]` | OPERATOR | 6 | ⬜ | `code-row`, `code-totals` (label+value order "Synced24 / 24"); button "Download CSV" |
| 20 | Reprint | `/operator/reprint` | OPERATOR | 6 | ⬜ | `#scan-input`; placeholder /Sticker torn/; button "Log reprint"; link "Print {code} (once)" |
| 21 | Void lot | `/operator/void` | OPERATOR | 6 | ⬜ | `#scan-input`; button "Void lot" |
| 22 | Verify (QC) | `/qc/verify` | QC | 11 | ⬜ | `#scan-input`; `scan-log`, `scan-checklist`, `checklist-*`, `data-count`; buttons "Confirm → PACKED", "Cancel", "Quarantine lot"; placeholder /Pack sticker missing/ |
| 23 | Containers | `/containers` | OPERATOR, WAREHOUSE, TRACE_OWNER | 11 | ⬜ | labels "Container number", "Container destination", "Container invoice", "Bill of Entry"; `container-{code}`, `container-count`, `container-lot`, `customs-clear`; status label texts; title text "Container … · Loading" in one block |
| 24 | Receive | `/receive` | WAREHOUSE, SS, DB, RETAILER | 7 | ⬜ | `#scan-input`; `scan-log`; `checklist-row`, `checklist-complete`; `inspect-result`, `return-row` |
| 25 | Dispatch | `/dispatch` | WAREHOUSE, SS, DB | 7 | ⬜ | labels "Destination", "Invoice"; option text "Choose…" and `{name} ({city})`; /Confirm dispatch/; "Remove {code} from the dispatch" |
| 26 | My stock | `/stock` | OPERATOR, QC, WAREHOUSE, SS, DB, RETAILER | 7 | ⬜ | `customs-split` ("Awaiting clearance") |
| 27 | Open lot | `/open-lot` | RETAILER | 9 | ⬜ | `#scan-input`, `scan-log` |
| 28 | Damaged | `/damaged` | OPERATOR, WAREHOUSE, SS, DB, RETAILER | 7 | ⬜ | sr-only `#damage-photo`, `#damage-extra-photos` with `<label htmlFor>`; `damage-*`, `damaged-*` test ids; buttons "Crushed / dented", "5. Report damaged", "Remove damage photo N"; scan box disabled until reason |
| 29 | My partners / retailers | `/my-partners` | SS, DB | 8, 10 | ⬜ | headings "My retailers", "My distributors and retailers" |
| 30 | Product details / Scan | `/details` | all | 11 | ⬜ | `#scan-input`; `details-*`, `came-from-*`, `info-*`, `chain-step`, `take-back-result`; only chain `li`s inside `details-chain`; aria-labels "Reason", "Note" |
| 31 | Print views | `/print/**` | OPERATOR | — | 🚫 out of scope | `.sticker*`, `.sheet`, mm sizes, print CSS, `print-run-*`, `scannable-preview`, "Mark as printed" |

## Open decisions (need your answer)

| # | Question | Default if not answered |
|---|---|---|
| D1 | Are QC, Customs (Warehouse) and Velza field staff in scope? | Yes — they share the same screens |
| D2 | Should the Overview page become a role dashboard with more figures? Only figures the existing APIs already return can be shown | Restyle only, same data |
| D3 | Add confirmation dialogs to Void lot / Cancel container? (behaviour change) | No |
| D4 | Stacked card rows on phones for the widest tables? | Yes, for Containers, Print orders, Stock, Receive checklist |
| D5 | Commit `docs/ui-baseline/` screenshots (≈125 PNGs) to the branch? | No — keep them local |

## Change log

| Date | Step | Commit | Regression result |
|---|---|---|---|
| 2026-11-20 | Audit + baseline | — (docs only) | lint ✅ · tsc ✅ · Vitest 938 passed / 9 skipped · e2e 20/20 · 41 screens, no errors |
| 2026-11-20 | Stitch tokens + shell + HQ dashboard | uncommitted | lint ✅ · tsc ✅ · Vitest 938 passed / 9 skipped · e2e 20/20 (incl. build) · sweep 36 pages × 9 widths: no problems · Chrome: no console errors |
