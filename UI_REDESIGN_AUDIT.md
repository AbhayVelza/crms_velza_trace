# Velza Traceability CRM — UI Redesign Audit

Status: **audit only, no source code changed.** Prepared 20 Nov 2026 on branch `develop/aditya` (HEAD `b7b8e91`).
Companion files: [UI_FUNCTIONALITY_BASELINE.md](UI_FUNCTIONALITY_BASELINE.md) (test results, timings, screenshots) and [UI_REDESIGN_TRACKER.md](UI_REDESIGN_TRACKER.md) (screen-by-screen checklist).

Everything below was traced from the source code and checked against the running app (http://localhost:3000, local PGlite data, every role signed in through the dev sign-in). Baseline screenshots of every screen are in `docs/ui-baseline/` (dark, light and 390 px phone views).

> **Waiting on you:** the Pinterest and Google Stitch references have not been shared yet. Sections 6 and 7 describe the current design system and the slots each reference will fill; they will be completed once the references arrive.

---

## 1. Existing system architecture

| Layer | What is there |
|---|---|
| Framework | Next.js **16.4.6** (App Router, Turbopack), React **19.3.0**, TypeScript 5 |
| Styling | Tailwind CSS **v4** (`@theme inline` tokens in `src/app/globals.css`, no `tailwind.config`), Open Sans variable font (local file) |
| Animation | `motion` **14.9.0** (pinned), primitives in `src/components/motion.tsx`, `PageFade.tsx` |
| Charts | Hand-written SVG/div charts in `src/components/charts.tsx` (no chart library) |
| Icons | ~55 inline Lucide-style SVG components in `src/components/icons.tsx` (no icon package) |
| Barcodes / scanning | `bwip-js` (sticker barcodes), `@zxing/browser` + `@zxing/library` (camera and photo decoding) |
| Data | Store abstraction `src/lib/store/` → JSON file, PGlite (`data/pg`, used now) or Neon Postgres; Zod validation |
| API | 50+ route handlers in `src/app/api/**`; business logic in `src/lib/services/*` and `src/lib/core/*` |
| Auth | Session cookie (`src/lib/sessionCookie.ts`); `src/proxy.ts` redirects to `/login` when there is no cookie; every API call re-checks the session and role. Sign-in can be turned off in development (`src/lib/signInMode.ts`), which shows the role/user switcher instead |
| Client data | `useApi(path)` (GET, keyed by path + user, `refreshOnChange`), `useAction(fn)` (blocks double submits), `api()` in `src/lib/client.ts`; `notifyDataChanged()` refreshes open views |
| Session | `SessionProvider` (`src/components/session.tsx`) loads `/api/auth/me` + `/api/bootstrap` (partners, flavours, countries) |
| Tests | Vitest (unit/contract), Playwright e2e (`tests/e2e`, production build on port 3100 with its own data), QA scripts (`tests/qa/*.mjs`) |

**Entry points and routing**
- `src/app/layout.tsx` — font, `<html data-theme>`, inline theme script (no flash).
- `src/app/(screens)/layout.tsx` — `MotionProvider › SessionProvider › ShellProvider`, then `Sidebar` + `AppHeader` + `<main>` → `RoleGate › PageFade › page`.
- Outside the shell: `/login`, `/signup` (`AuthShell`), `/print/**` (always light, print CSS), `/t/[code]` (public QR check page).
- Access: `MENU` in `src/lib/menu.ts` decides each role's pages; `rolesForPath()` + `RoleGate` show "This page is not part of the … portal" for others; the API enforces the real rules.

---

## 2. Screen and role inventory

### Roles (from `src/lib/core/types.ts` and `src/lib/menu.ts`)

The brief lists six dashboards; the code has **nine roles**. The three extra ones need a decision on whether they are in scope (they share the same screens, so most work carries over).

| Role code | Label in app | In the brief? | Menu |
|---|---|---|---|
| `ADMIN` | Velza Admin | Admin | Partners, Sign-ins & passwords, Devices, Countries & flavours, Batch code pools, Settings, Product details |
| `TRACE_OWNER` | Velza HQ | Trace Owner | Dashboard (`/hq`), Search code, Alerts, Batches & recall, Containers, Scan audit, Product details |
| `OPERATOR` | Manufacturer Operator | Operator | New print order, Print orders, Containers, Reprint, Void lot, My stock, Product details, Damaged |
| `QC` | Manufacturer QC | **not listed** | Verify, My stock, Product details |
| `WAREHOUSE` | Customs (Velza) | **not listed** | Receive, Containers, Dispatch, My stock, Product details, Damaged |
| `SS` | Super Stockist | Super Stockist | Receive, Dispatch, My stock, Product details, Damaged, My partners |
| `DB` | Distributor | Distributor | Receive, Dispatch, My stock, Product details, Damaged, My retailers |
| `RETAILER` | Retailer | Retailer | Receive, Open lot, My stock, Product details, Damaged |
| `VELZA_FIELD` | Velza field staff | **not listed** | Scan (`/details` only) |

Every signed-in role also has `/` (Overview) and `/account`.

Only `TRACE_OWNER` has a true analytics dashboard (`/hq`). For every other role the "dashboard" is the shared Overview page `/`: four stock tiles (roles that have My stock) plus Quick-access cards from their menu.

### Screens

Legend for data: all `GET` unless a method is shown. "Shared" = same file serves several roles with role branches.

| # | Screen | Route | Roles | Main components | Data sources | Key actions |
|---|---|---|---|---|---|---|
| 1 | Overview (role home) | `/` | all | `PageTitle`, `Stat`, `Reveal`, quick-access `Card`s from `MENU` | `/api/stock` (only roles with My stock) | Navigate |
| 2 | Account | `/account` | all | `Card`, `Field`, `Input` | `POST /api/auth/password` | Change password |
| 3 | Sign in | `/login` | public | `AuthShell`, `ActAsPicker` (dev) | `/api/auth/me`, `POST /api/auth/login`, dev: `/api/auth/mode`, `/api/auth/dev-users`, `POST /api/auth/dev-login` | Sign in |
| 4 | Sign up | `/signup` | public | `AuthShell wide`, radio cards | `/api/signup`, `POST /api/signup` | Create SS/DB/Retailer account |
| 5 | Public QR check | `/t/[code]` | public | `PublicLookup` | `/api/lookup/{code}?view=public` | Read-only status |
| 6 | Partners | `/admin/partners` | ADMIN | `PendingApprovals`, `RegisterForm`, `AdminCrud`, `PasswordInput` | `POST /api/admin/approvals/{id}`, `POST /api/admin/partners`, AdminCrud `partners` | Approve/reject, register, inline edit, filter |
| 7 | Sign-ins & passwords | `/admin/users` | ADMIN | `NewSignIn`, `AdminCrud` | `POST /api/admin/users`, AdminCrud `users` | Create sign-in, set password, activate |
| 8 | Devices | `/admin/devices` | ADMIN | `AdminCrud` | AdminCrud `devices` | Add/edit/delete device |
| 9 | Countries & flavours | `/admin/reference` | ADMIN | 2 × `AdminCrud` | `countries`, `flavours` | Add/edit/delete |
| 10 | Batch code pools | `/admin/pools` | ADMIN | Card per device, `Table` | `/api/admin/pools`, `POST /api/admin/pools` | Issue codes |
| 11 | Settings | `/admin/settings` | ADMIN | 6 `Card`s, `Field`s | `/api/admin/settings`, `PUT` | Save settings |
| 12 | HQ dashboard | `/hq` | TRACE_OWNER | `Stat`, `BarChart`, `DonutChart`, `MeterList`, `Table`, skeleton | `/api/dashboard` (polled 15 s), `/api/returns/report` | Refresh, drill into alerts/search |
| 13 | Search code | `/hq/search` | TRACE_OWNER | `ScanInput`, detail cards, timeline `Table` | `/api/lookup/{code}`, `?code=` deep link | Search, click parent/children |
| 14 | Alerts | `/hq/alerts` | TRACE_OWNER | chip filters, `Table`, paging | `/api/alerts?…`, `POST /api/alerts` | Filter, acknowledge/close/reopen |
| 15 | Batches & recall | `/hq/batches` | TRACE_OWNER | `Table`, `BatchReport`, recall card | `/api/batches`, `/api/batches/{code}`, `/api/recall`, `POST /api/recall` | Report, two-step recall |
| 16 | Scan audit | `/hq/scans` | TRACE_OWNER | `Table` | `/api/scans` (latest 300) | Read only |
| 17 | New print order | `/operator/new` | OPERATOR | 7-step wizard / 4-step continue wizard, `CountInput`, `StepList` | `POST /api/print-orders` (preview, create), `/api/print-orders/continue`, `POST …/continue` | Create print order |
| 18 | Print orders | `/operator/orders` | OPERATOR | `Table`, `PrintOrderStatus` | `/api/print-orders` | Open print view / codes |
| 19 | Order codes | `/operator/orders/[id]` | OPERATOR | `GeneratedCodes` (5 stats + 18-col table) | `/api/print-orders/{id}/codes` | Download CSV |
| 20 | Reprint | `/operator/reprint` | OPERATOR | `ScanInput`, `Table` | `/api/reprint`, `POST /api/reprint` | Log reprint → print once |
| 21 | Void lot | `/operator/void` | OPERATOR | `ScanInput`, danger `Button` | `POST /api/void` | Void a lot |
| 22 | Verify (QC) | `/qc/verify` | QC | `ScanInput`, `ScanChecklist`, `ScanLog` | `POST /api/verify` (scanLot/scanPack/confirm/quarantine) | Verify → PACKED, quarantine |
| 23 | Containers | `/containers` | OPERATOR, WAREHOUSE, TRACE_OWNER (shared) | `Table`, detail card, `ScanInput` | `/api/containers`, `POST` create/load/unload/dispatch/clear, `DELETE` | Load, dispatch, clear, cancel |
| 24 | Receive | `/receive` | WAREHOUSE, SS, DB, RETAILER (shared) | `ScanInput`, `ScanChecklist`, `ScanLog`, Customs: returns table | `/api/stock`, `POST /api/receive`, Customs: `/api/returns`, `POST /api/returns/inspect` | Scan in, inspect returns |
| 25 | Dispatch | `/dispatch` | WAREHOUSE, SS, DB (shared) | `Select`, `Input`, `ScanInput`, checklist | `/api/dispatch`, `/api/stock`, `POST /api/dispatch` (check, confirm) | Scan out with invoice |
| 26 | My stock | `/stock` | OPERATOR, QC, WAREHOUSE, SS, DB, RETAILER (shared) | `Stat`, `StockTable` ×3–4 | `/api/stock` | Read only |
| 27 | Open lot | `/open-lot` | RETAILER | `ScanInput`, `ScanLog` | `POST /api/open-lot` | Open a case/tray |
| 28 | Damaged | `/damaged` | OPERATOR, WAREHOUSE, SS, DB, RETAILER (shared) | 5-step form, file inputs, history `Table` | `/api/damaged`, `POST /api/damaged` | Report damage with photos |
| 29 | My partners / My retailers | `/my-partners` | SS, DB | `Table` | `/api/my-partners` | Read only |
| 30 | Product details / Scan | `/details` | all roles (field staff see "Scan") | `ScanInput`, `Details` / `FullInfo`, `TakeBack` | `/api/details/{code}`, `POST /api/returns/take-back` | Look up, take back |
| 31 | Print views | `/print/[orderId]`, `/print/reprint/[id]`, `/print/code/[code]` | OPERATOR | `PrintView`, `Stickers` | `/api/print-orders/{id}`, `POST …/printed` | Print stickers (**print-critical**) |

**Responsive behaviour today:** Tailwind default breakpoints (sm 640, md 768, lg 1024, xl 1280, 2xl 1536). Sidebar becomes an off-canvas drawer below 1024 px (focus trap, Escape, scroll lock); header wraps to two rows below 1280 px. All tables scroll sideways inside `Table` (`overflow-x-auto`). The earlier responsive sweep (320–1920 px, every role's routes) found no page-level horizontal overflow.

---

## 3. Component inventory

**Design primitives — `src/components/ui.tsx`** (number of files that use each)

| Export | Variants / props | Uses |
|---|---|---|
| `Notice` | tone ok / error / warn / info | 32 |
| `PageTitle` | title, subtitle, eyebrow, actions (`h1`) | 27 |
| `Button` | primary / secondary / outline / danger / ghost, `loading` | 27 |
| `Card` | title, icon, actions (`<section>` + `h2`) | 26 |
| `Code` | monospace text | 21 |
| `Input` / `Select` / `Field` | `Field` wraps the control in a `<label>` | 20 / 11 / 15 |
| `Table` / `Td` | head, empty; horizontal scroll | 16 |
| `Empty`, `Loading`, `Skeleton`, `LoadingPage` | states | 14 / 13 / 1 / 1 |
| `StatusBadge`, `Pill` | status → tone; tone + dot | 10 / 9 |
| `Stat` | label, value, icon, tone, hint, share meter | 5 |
| `cx`, `fmtTime` | helpers | 13 / 17 |

**Shell:** `Sidebar.tsx` (`MENU_ICONS`, drawer + collapsible rail, Motion active pill), `AppHeader.tsx` (breadcrumb, signed-in user, dev role switcher or Account + Sign out, theme switcher, Operator `DeviceBar` row), `ThemeSwitcher.tsx` + `themeScript.ts`, `PageFade.tsx`, `motion.tsx`, `brand.tsx`, `icons.tsx`, `AuthShell.tsx`.

**Feature components:** `ScanInput` (scan box with auto-refocus, camera, demo helper — used on 10 screens), `ScanChecklist` + `useChecklist` (3), `ScanLog` (6), `StockTable` (3), `AdminCrud` (5 admin screens), `ConfirmDialog` (AdminCrud only), `PasswordInput`, `DeviceBar` (Operator), `GeneratedCodes`, `PrintView`, `PrintOrderStatus`, `Stickers`, `ActAs` (dev only), `charts.tsx` (HQ only).

**Shared across roles (change once, affects many):** the whole shell, `ui.tsx`, `ScanInput`, `ScanChecklist`, `StockTable`, and the shared pages Overview, Receive, Dispatch, Containers, My stock, Damaged, Product details.

---

## 4. Functionality preservation checklist

These are the hooks the tests and the app rely on. A redesign must keep every one of them. (Full lists per screen are in the tracker.)

- [ ] **Element ids:** `#scan-input`, `#damage-photo`, `#damage-extra-photos`, `#app-sidebar`, `#app-menu-button`, `#scan-camera`, `confirm-dialog-title/body`.
- [ ] **`data-*` hooks:** every `data-testid` (≈60, e.g. `scan-log`, `checklist-row`, `container-count`, `details-chain`, `summary-batch-N`, `register-result`, `signed-in-user`, `public-status`), plus `data-field`, `data-code`, `data-kind`, `data-status`, `data-count`, `data-ok`, `data-camera-panel`, `data-demo-code`.
- [ ] **Accessible names used by tests:** every `aria-label` and every `Field` label text (e.g. "Destination", "Invoice", "Container number", "Bill of Entry", "Sign-in ID", "Current password"), button texts ("Next", "Create & print", "Confirm → PACKED", "5. Report damaged", "Sign out", "Open menu"…), radio names beginning with the type label on Sign up.
- [ ] **Visible texts asserted exactly:** "PRINTING PENDING", "PRINTED", "This page is not part of the … portal", container status labels, `{name} ({city})` option format, menu labels in `nav`, headings "My retailers" / "My distributors and retailers".
- [ ] **Structure the tests read:** `Card` renders `<section>`; `Field` wraps a `<label>`; table column order (first cell = ID / tier; `/hq/search` timeline column 2 = Event); `details-chain` contains only the chain `<li>`s; `div.rounded-md` per-batch wrapper on the wizard flavour step (a test selects it by that class).
- [ ] **Behaviour carried by markup:** scan-box refocus rules (ignores `#app-sidebar`, `[data-camera-panel]`, other fields); sr-only file inputs with `<label htmlFor>`; wizard step indices; AdminCrud row `key` (forces remount after save); `ConfirmDialog` native `<dialog>`; theme script and `velza-theme` / `velza-sidebar` keys.
- [ ] **Print:** `.sticker`, `.sticker-lot`, `.sticker-pack`, `.sheet`, mm sizes, quiet zone, `--screen-zoom`, `print:hidden` toolbar, forced light theme.
- [ ] **No new data paths:** no new API calls, no mock data, no changed request bodies, no new routes.

---

## 5. Current design problems

Observed in the live app and screenshots (`docs/ui-baseline/`), then confirmed in code.

**Shell**
1. **Phone header is very tall.** At 390 px the header (menu, logo, portal, theme switcher, user line, two dev selects) takes ~230 px before the page title. In production the two selects become Account/Sign out, but it is still ~150 px.
2. Sidebar user block avatar and the Next.js dev indicator overlap bottom-left in development (dev-only; not a production issue, but it hides the user's initials while testing).
3. Breadcrumb repeats the page title right below it; the eyebrow ("VELZA HQ") repeats the portal name a third time.

**Dashboards and overview**
4. **Overview is identical for every role** — it is a launcher, not a dashboard. Roles other than HQ have no "what needs my attention" view (incoming count is the only signal).
5. HQ dashboard: raw enum labels shown to users (`GENERATED`, `NOT RECEIVED`, `PUBLIC BLOCKED`) in uppercase; uneven card heights (Recent alerts card mostly empty space); bar chart labels truncate on phones; a single-value bar chart looks broken when only one status exists.
6. Overview/My stock tiles have no loading state (they pop in late; blank area first).

**Tables and forms**
7. **Wide tables** (Partners 16 columns, GeneratedCodes 18, Returns 10, Containers 10, wizard Summary 8–9) rely only on sideways scrolling; on phones they are hard to read. No sticky first column, no sticky header.
8. Admin inline-edit tables render every cell as a full input box, so the table reads like a form; text is clipped (`Velza Warehouse I…`).
9. Empty-state messages show while data is still loading on AdminCrud, Receive returns, My partners ("Nothing yet" flashes).
10. Long explanation paragraphs at the top of cards (Partners, Settings) push the actual form down; they could be collapsible help.
11. Small touch targets: "Take out" (Containers), password Hide/Generate buttons, alert-type chips.

**Workflow screens**
12. Wizard step bar (7 pills) wraps to three lines on phones; Back/Next footer scrolls off-screen.
13. Scan screens show the result only in a small log list — no large success/failure banner for warehouse use at arm's length.
14. Destructive actions are inconsistent: Void lot and Cancel container have no confirmation dialog, Recall uses an inline confirm, AdminCrud uses `ConfirmDialog`. (Adding a confirmation is a behaviour change — listed for your decision, not for the redesign.)

**Visual system**
15. Card titles in dark mode use red icon tiles on every card — with many cards on one page the red loses meaning; red should mark the primary action and alerts.
16. Inconsistent status colours: `Pill` tones, `StatusBadge`, and chart colours each define their own mapping.

**Known stale item (not UI):** `tests/qa/qaUi.mjs` still expects "Dispatch" in the Operator menu, which was replaced by Containers on 16 Nov 2026. Recorded, not fixed.

---

## 6. Proposed UI design system

Principle: **keep the existing token architecture and primitives; restyle them.** Because almost every screen is built from `ui.tsx` + `globals.css`, most of the redesign lands in those two files and the shell, and the screens follow automatically.

| Area | Today | Proposal (to be tuned to your references) |
|---|---|---|
| Colour | Dark `#070606` / surface `#121011`, light `#fafafa` / `#fff`, primary `#e62117` / `#d61e14`; red page glow | Keep Velza red as the only accent. Neutral greys for structure; red reserved for primary action, active nav, alerts. One semantic status palette (success / warning / danger / info / neutral) shared by `Pill`, `StatusBadge` and charts |
| Typography | Open Sans 300–800 | Keep Open Sans (already bundled, no download). Define a fixed scale: page 28/32, section 18, body 15, table 14, caption 12; tabular numbers for all figures |
| Spacing / radius | `rounded-control` 10 px, `rounded-card` 14 px, ad-hoc gaps | 4 px grid; tokens for card padding (20/24), section gap (24), dense table row (40) and comfortable row (48) |
| Layout | Sidebar 256 px / rail 76 px, `max-w-app` 100 rem | Same structure; compact phone header (single 56 px bar, user + theme in a menu); optional page-level tab bar for screens with several tables |
| Cards | Bordered, red icon tile in title | Neutral icon tile, red only when the card is an alert/action card; consistent header row (title, count, actions) |
| Tables | Scroll sideways | Sticky header, sticky first column, dense/comfortable density, row hover, numeric right-align; on phones optional stacked "card rows" for the 4–5 most used tables (same data, same order) |
| Forms | Labelled fields in grids | Grouped sections with headings, help text collapsible, sticky save/submit bar on long forms |
| Buttons | 5 variants | Keep variants and names; add size `sm` / `md` / `lg`, min 44 px touch target on phones |
| Status | `Pill`, `StatusBadge` | One `StatusBadge` mapping used everywhere, human-readable labels in the UI only (API values unchanged) |
| Charts | Bar, donut, meter (SVG) | Keep (no chart library needed). Readable labels on phones, consistent palette, empty/one-value states |
| Motion | Reveal, page fade, animated numbers, `reducedMotion="user"` | Keep; shorter durations for data screens, no motion on scan results except the result banner |
| Icons | Inline Lucide-style set | Keep; add any missing glyphs by hand (no icon package) |

**New packages:** none needed. Everything above can be done with Tailwind v4, Motion and the existing SVG charts. If a reference needs something these cannot do (for example a complex data grid), I will explain why before adding anything.

---

## 7. Reference-to-screen mapping

To be completed when the references arrive. Each approved reference will be assigned like this:

| Reference (Pinterest / Stitch) | Applies to | Elements taken | Existing screen(s) |
|---|---|---|---|
| _pending_ | App shell | sidebar, header, page title | all signed-in screens |
| _pending_ | Admin | tables, forms | 6–11 |
| _pending_ | Trace Owner dashboard | stat tiles, charts, alert list | 12–16 |
| _pending_ | Operator | wizard, print orders | 17–21 |
| _pending_ | Partner portals (SS / DB / Retailer / Customs) | overview, scan screens | 1, 24–30 |
| _pending_ | Auth + public | sign in, sign up, QR page | 3–5 |

Rule: a reference can change how an existing screen looks; it cannot add a screen, a route, a field or a data source. Anything in a reference that has no counterpart in the app will be listed as "not applicable" instead of being built.

---

## 8. Files allowed to change (styling only)

**Safe — visual only**
- `src/app/globals.css` (tokens, utilities; keep the `@media print` block and the theme/sidebar variants)
- `src/components/ui.tsx` (classes and markup of primitives — keep `Card` as `<section>`, `Field` as `<label>`, prop names and defaults)
- `src/components/Sidebar.tsx`, `AppHeader.tsx`, `ThemeSwitcher.tsx`, `AuthShell.tsx`, `brand.tsx`, `icons.tsx`, `charts.tsx`, `motion.tsx`, `PageFade.tsx`, `StockTable.tsx` (not `Stickers.tsx`, see section 9)
- Page files under `src/app/(screens)/**/page.tsx`, `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/app/t/[code]/PublicLookup.tsx`: **className and layout wrappers only**

**Allowed with extra care (behaviour lives in the markup)**
- `ScanInput.tsx`, `ScanChecklist.tsx` (focus rules, ids, test ids)
- `AdminCrud.tsx` (row key, aria-labels from column labels, blur-save)
- `DeviceBar.tsx`, `PasswordInput.tsx`, `ConfirmDialog.tsx`, `ActAs.tsx`
- `operator/new/page.tsx` (step indices, `div.rounded-md` hook), `damaged/page.tsx` (sr-only file inputs), `containers/page.tsx`, `dispatch/page.tsx`
- `PrintView.tsx` — on-screen toolbar only, never the sheet

## 9. Files that must remain untouched

- `src/app/api/**` (all route handlers)
- `src/lib/**` — services, core rules, permissions, store, scan logic, `menu.ts` (labels are asserted by tests and define access), `client.ts`, `events.ts`, `format.ts`
- `src/proxy.ts`, `src/components/session.tsx`, `useApi.ts`, `useAction.ts`, `RoleGate.tsx` (logic), `themeScript.ts` (logic)
- `src/components/Stickers.tsx`, `src/app/print/**`, the sheet part of `PrintView.tsx`
- `db/`, `scripts/`, `data/`, `tests/`, `next.config.ts`, `package.json` / lock file, `.env*`, `neon.ts`

---

## 10. Screen-by-screen implementation plan

Order follows the brief. Each step is a separate commit on `develop/aditya`, checked with the regression steps in section 11 before the next one.

| Step | Scope | Files | Notes |
|---|---|---|---|
| 1 | Design tokens and primitives | `globals.css`, `ui.tsx` | Status palette, type scale, table density/sticky header, button sizes, loading states. Every screen updates from this |
| 2 | Sidebar and navigation | `Sidebar.tsx` | Keep ids, `aria-current`, drawer behaviour, collapse key |
| 3 | Header and user controls | `AppHeader.tsx`, `ThemeSwitcher.tsx`, `DeviceBar.tsx` | Compact phone header; keep "Sign out", `signed-in-user`, theme radio names |
| 4 | Admin screens | `admin/*`, `AdminCrud.tsx` | Read-mode cells that turn into inputs on focus (same inputs, same names), grouped register form, skeletons |
| 5 | Trace Owner dashboard + HQ screens | `hq/*`, `charts.tsx` | Readable labels, balanced grid, timeline styling, report scroll-into-view |
| 6 | Operator | `operator/*`, `GeneratedCodes.tsx`, `PrintView` toolbar | Compact step indicator, sticky wizard footer, order list |
| 7 | Super Stockist | `/`, `/receive`, `/dispatch`, `/stock`, `/damaged`, `/my-partners` | Shared screens — also improves DB, Retailer, Customs |
| 8 | Distributor | same shared screens | Check DB-specific labels ("My retailers") |
| 9 | Retailer | `/open-lot` + shared | |
| 10 | Partner management | `admin/partners`, `/my-partners` | |
| 11 | Forms and detail screens | `/details`, `/account`, `/containers`, `/qc/verify`, `/login`, `/signup`, `/t/[code]` | Chain as timeline (still `li`s) |
| 12 | Reports and analytics | `/hq/batches`, `/hq/scans`, `/hq/alerts` | |
| 13 | Remaining | Customs and QC variants, empty/error states, dark/light parity | |

Not included without your approval (they change behaviour, not just looks): adding confirmation dialogs to Void lot / Cancel container, adding filters to Scan audit, role-specific dashboards with new data, changing any wording that tests assert.

---

## 11. Testing and regression strategy

After every step:
1. `npm run lint`, `npx tsc --noEmit`, `npm test` (Vitest) — must match the baseline.
2. `npx playwright test` (e2e, isolated build on port 3100) — must match the baseline.
3. Responsive sweep script (all roles × 9 widths, 320–1920 px) — no horizontal overflow, no console errors.
4. Screenshot comparison against `docs/ui-baseline/` for the screens touched, in dark, light and phone.
5. Manual browser pass of the changed screens with a real role, including one full scan flow (receive or dispatch) and the print view.
6. Keyboard and screen-reader spot check: focus ring visible, drawer focus trap, scan box keeps focus.

## 12. Potential risks

| Risk | Where | Mitigation |
|---|---|---|
| Breaking e2e selectors by changing text, class or structure | Everywhere, especially wizard `div.rounded-md`, column order, `Card`/`Field` tags | Keep the checklist in section 4; run e2e after each step |
| Scan box losing focus (USB scanners stop working) | `ScanInput`, any new focusable wrapper, sidebar id | Do not wrap in focusable elements; keep `#app-sidebar`; test with a real scan |
| Print output changing size | `Stickers`, `PrintView`, print CSS | Do not touch; print-preview check each release |
| Shared screens changing for roles nobody looked at | Receive, Dispatch, Containers, Stock, Damaged, Details | Sweep and screenshot every role, not just the one being worked on |
| Theme flash or wrong theme | `themeScript`, `data-theme` tokens | Keep the script and keys; check both themes and "System" |
| Dev server serving stale CSS after `globals.css` edits | Turbopack | Restart the dev server after token changes |
| References that imply new features | Stitch mock-ups | Map to existing screens only; list anything else as not applicable |
| Neon still paused | Live Vercel site returns 500s | UI work and tests run on local PGlite / JSON; the live site needs the database plan, not UI changes |
