# HQ Dashboard: Stitch → CRM Implementation Map

Written before any code change on 20 Nov 2026. Branch `develop/aditya`, HEAD `b7b8e91`. The working tree had no uncommitted source changes; the only untracked files were the audit documents and `docs/ui-baseline/`.

## Sources

- `DESIGN.md` is the design system and the primary specification.
- `screen.png` is the approved look.
- `code.html` is a visual reference only; none of its code is copied.

The deliverables were attached in chat and saved to this folder.

**Pre-implementation audit results**
- Route: `/hq`, file `src/app/(screens)/hq/page.tsx`. Only `TRACE_OWNER` can open it (`MENU.TRACE_OWNER`, exact match on `/hq`).
- Data:
  - `GET /api/dashboard` through `useApi(…, { refreshOnChange: true })`. It is polled every 15 s by `setInterval(reload, 15_000)`, and the Refresh button calls `reload`.
  - `GET /api/returns/report` through `useApi(…, { refreshOnChange: true })`.
- States:
  - `error` shows `<Notice tone="error">`.
  - `!d` shows `DashboardSkeleton` (built on `LoadingPage`).
  - Each card has its own empty state.
  - The Returns card shows "Loading…" text until its data arrives.
- Shell: `Sidebar.tsx`, `AppHeader.tsx`, `ThemeSwitcher.tsx` + `themeScript.ts`, and `(screens)/layout.tsx`.
- Theme:
  - The theme is set on `<html data-theme>` before first paint by `THEME_SCRIPT`.
  - The choice is stored in localStorage `velza-theme`; dark is the default.
  - The sidebar collapse state is stored in `velza-sidebar` (`data-sidebar`).

## Component mapping

| Stitch element | Existing CRM component | Existing data source | Existing interactions | Files to modify | Must be preserved |
|---|---|---|---|---|---|
| Presentation toolbar ("HQ SYSTEM v3.4.1", Light/Dark) | — | — | — | none | **Not implemented.** It is a prototype control; the app's own `ThemeSwitcher` stays |
| Ambient mesh background (red blobs, film grain) | `body` `--page-glow` | — | — | `globals.css` | Reconciled with DESIGN.md ("monochromatic canvases"): only a faint corner glow, no 55 % red blobs |
| Sidebar, 240 px, brand, portal label, nav, profile footer | `Sidebar` | `useSession()` role, user, organisation; `MENU[role]` | Links, drawer (Escape, focus trap, scroll lock, `inert`), desktop collapse (`velza-sidebar`), Motion active pill | `Sidebar.tsx`, `globals.css` (variant), `(screens)/layout.tsx` (Suspense fallback width) | `#app-sidebar`, `aria-label="Sidebar"`, `nav[aria-label=Main]`, `aria-current="page"`, menu labels, Close menu button, `inert` while the drawer is closed |
| Tablet 68 px icon rail | (new breakpoint behaviour of `Sidebar`) | same | Tooltips on hover/focus | `Sidebar.tsx` | All destinations stay links with accessible names (labels become screen-reader-only, as in today's collapsed rail) |
| Mobile drawer | `Sidebar` + `MenuButton` | same | Open menu → drawer | `Sidebar.tsx` | `#app-menu-button`, name "Open menu", `aria-expanded`, `aria-controls` |
| Top bar, 56 px, frosted | `AppHeader` | `useSession()`, `useDevUsers()` | Collapse sidebar, breadcrumb link to `/`, theme, Act-as selects (development) or Account / Sign out | `AppHeader.tsx`, `ThemeSwitcher.tsx` (size only) | `data-testid="signed-in-user"` (one element, text = user name), button "Sign out", theme radiogroup "Theme" with "Light/Dark/System theme", Role/User selects |
| "Online · Synced just now / Unsynced: 0 lots" pill | `DeviceBar` (**Operator only**) | `/api/devices`, `/api/sync` | Online/Offline, Sync | none | HQ has no device or sync state, so **the pill is not added to HQ** (that would invent data). The Operator keeps `DeviceBar` on its second row, unchanged |
| Organisation dropdown "Velza HQ ▾" and user pill "VH Velza HQ (HQ0001) ▾" | `ActAsSwitcher` (Role, User selects; development only) and the signed-in user block | `/api/auth/dev-users` | Switch role or user (reloads) | `AppHeader.tsx` | Same selects and the same `actAs()` call. Below 1280 px they sit in a small account panel opened from the user chip, so the bar stays one row |
| Page header (eyebrow, title, description, Refresh) | `PageTitle` + `Button` | `d.threshold` | Refresh → `reload()`; spinner while `refreshing` | `ui.tsx`, `hq/page.tsx` | `h1` "HQ dashboard"; Refresh calls the same `reload` |
| "Last updated: Just now" | — | not provided by `/api/dashboard` | — | none | **Not added**: the app has no last-updated value (the brief says "where currently supported") |
| KPI cards ×5 | `Stat` ×5 inside `Reveal` | `d.totals.batches`, `d.totals.lots`, `d.totals.packs`, `d.inTransit.length`, sum of `d.alertCounts` | Count-up animation | `ui.tsx` (`Stat`), `hq/page.tsx` | Same values and calculations. The overdue in-transit warn tone stays; the Alerts danger tone stays |
| KPI hints ("Production active", "+12% this week", "All generated units", "No active dispatches") | `Stat.hint` | — | — | — | **Not added**: invented or unsupported figures. Only "All clear" is shown, because it is derived from `alertTotal === 0` |
| Alerts tile with green top bar | `Stat` `tone` | `alertTotal` | — | `ui.tsx` | Red when alerts > 0 (unchanged meaning), green "ok" bar when 0 |
| Lots by status (bars, value labels, mono axis, "Total" chip) | `BarChart` in `Card` | `d.lotCounts` for the statuses present (`presentStatuses`) | Hover readout; sr-only table | `charts.tsx`, `hq/page.tsx` | Same statuses and values; the chip shows the existing `d.totals.lots`. Zero-value statuses are **not** added (the existing chart shows the statuses present) |
| Pack status mix (donut, legend) | `DonutChart` | `d.packCounts` | — | `charts.tsx` | Same segments, `STATUS_COLORS`, centre total |
| Recent alerts (+ calm empty state) | `Card` + list | `d.recentAlerts` | "All alerts" → `/hq/alerts` | `hq/page.tsx` | Same link and items. Alert type shown in sentence case (display only) |
| Alerts by type (9 rows) | `MeterList` | `d.alertCounts` for the 9 `ALERT_TYPES` | — | `charts.tsx`, `hq/page.tsx` | Same 9 types, counts and sort order; labels in sentence case |
| Counts by status (table + note) | `Table` + `StatusBadge` + `<p>` | `presentStatuses`, `d.lotCounts`, `d.packCounts` | — | `ui.tsx`, `hq/page.tsx` | Same rows and status labels; same note text |
| Stock by location | `Table` | `d.stock` | — | `hq/page.tsx` | Same 7 columns in the same order. First cell = tier label (test `row /^Super Stockist SS-1/`). The awaiting-print, awaiting-QC and quarantined notes stay in the Cases cell |
| Amber "407 lot(s) not printed yet in Vietnam facility · Review lots →" callout | the existing "N lot(s) not printed yet" note | `s.awaitingPrint` | — | — | Kept as the existing inline note. **No "Review lots" link** (a new navigation path) |
| In transit (0) | `Card` + `Table` | `d.inTransit` | Code → `/hq/search?code=` | `hq/page.tsx` | Same 3 columns, link, overdue highlight |
| Returns (0) with 4 combined columns | `ReturnsReport` `Table` | `/api/returns/report` | Code → `/hq/search?code=` | `hq/page.tsx` | **All 10 existing columns kept** (the brief says keep the existing columns), `data-testid="returns-row"`, `data-code`. "Loading…" becomes skeleton rows; an error Notice is added from the hook's existing `error` |
| Loading skeleton | `DashboardSkeleton` / `LoadingPage` | — | — | `hq/page.tsx` | Same grid as the loaded page |

## Shared components touched (visual only)

| File | Change | Effect on other screens |
|---|---|---|
| `src/app/globals.css` | DESIGN.md tokens for both themes, radii (8 / 12 / 16 / 24), shadows, fonts, `rail` variant | Every screen takes the new colours and radii (intended: shared design system) |
| `src/app/layout.tsx` | Inter + JetBrains Mono through `next/font/google` (self-hosted at build time; browsers never contact Google; no npm package) | All text |
| `src/components/ui.tsx` | `PageTitle`, `Card`, `Stat`, `Table`, `Empty`, `Code`, `Button` styling; optional `Table.align`, `Stat` `ok` tone | Restyled everywhere; existing props unchanged and only additive props added |
| `src/components/charts.tsx` | Neutral bars with value labels, donut and meter styling | Used only by `/hq` |
| `src/components/Sidebar.tsx`, `AppHeader.tsx`, `ThemeSwitcher.tsx`, `(screens)/layout.tsx` | Shell per DESIGN.md | Every signed-in screen |

**Not touched:** `src/app/api/**`, `src/lib/**`, `session.tsx`, `useApi.ts`, `useAction.ts`, `themeScript.ts`, `RoleGate.tsx`, `menu.ts`, `DeviceBar.tsx`, `ActAs.tsx`, `Stickers.tsx`, `src/app/print/**`, `tests/**`, `package.json`, `.env*`, `next.config.ts`.

## Conflicts found and decisions

| # | Conflict | Decision |
|---|---|---|
| C1 | DESIGN.md YAML `primary: #b9001d` vs narrative `#DF2531` | `#DF2531` (narrative; also `primary-container` in YAML and `velza.red` in code.html). Hover `#C01C27` |
| C2 | Secondary text `#86868B` (light) gives 3.6:1 on white; tertiary `#AEAEB2` gives 2.1:1; dark tertiary `#636366` gives 2.9:1. All fail WCAG AA for small text | Light: secondary `#6E6E73`, tertiary `#737378`. Dark: secondary `#98989D`, tertiary `#86868B`. The colours stay within the same grey family |
| C3 | Semantic colours `#34C759`, `#FF9F0A`, `#0A84FF` are too light to be text on white | In light, text uses AA shades (`#1E7F35`, `#A35F00`, `#D70015`, `#0060DF`); tints use the DESIGN.md colours. In dark, the DESIGN.md colours are used (danger `#FF453A`, info `#409CFF` for contrast) |
| C4 | DESIGN.md: "Light Mode (default)". The app defaults to dark | **Keep dark as the default.** The brief says to preserve the existing theme preference and behaviour |
| C5 | code.html frosted, translucent cards vs DESIGN.md "crisp `#FFFFFF` / `#1C1C1E` with hairline borders" | Solid cards (DESIGN.md, better contrast). Frosted blur only on the top bar |
| C6 | Card radius: code.html 20 px vs DESIGN.md 16 px | 16 px |
| C7 | DESIGN.md: KPI shelf as a 1-column stack below 768 px; code.html: 2 columns | 2 columns on phones (code.html), so the five tiles don't fill two screens; Alerts spans the full row |
| C8 | Stitch Returns card has 4 merged columns | Keep the 10 existing columns (functionality lock). Stock by location goes full width (as in Stitch); In transit (⅓) and Returns (⅔) share the next row, so the 10-column table has room. Below 1024 px they stack |
| C9 | Stitch shows sync status, last-updated time, trend hints and a "Review lots" link that HQ data does not have | Not implemented (see the table above) |
| C10 | DESIGN.md: active nav = "bold Velza Red background with white text" vs screen.png: neutral pill with a red dot | Neutral pill, red dot and red icon (screen.png is the approved look and keeps red restrained). `aria-current` is unchanged |
