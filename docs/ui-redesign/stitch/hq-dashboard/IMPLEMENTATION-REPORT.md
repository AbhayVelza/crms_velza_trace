# HQ Dashboard: Stitch Implementation Report

**Date:** 20 Nov 2026
**Branch:** `develop/aditya`, uncommitted on top of `b7b8e91`
**Scope:** the Velza HQ dashboard (`/hq`) and the shared pieces it needs: tokens, fonts, sidebar, top bar and UI primitives
**Status:** awaiting approval; no other dashboard has been redesigned
**Plan and conflict decisions:** [IMPLEMENTATION-MAP.md](IMPLEMENTATION-MAP.md)

## Result

| Check | Before (baseline) | After |
|---|---|---|
| `npm run lint` | pass | **pass** |
| `npx tsc --noEmit` | pass | **pass** |
| Vitest | 938 passed, 9 skipped | **938 passed, 9 skipped, 0 failed** |
| Playwright e2e (includes `npm run build`) | 20 / 20 | **20 / 20** (5.1 min) |
| Responsive sweep: all roles, 36 pages × 9 widths, 320–1920 px | no problems | **no problems** (no sideways scroll, no console errors) |
| HQ dashboard: 2 themes × 5 widths (1440, 1280, 1024, 768, 390) | — | **no overflow, no console errors** |
| Live check in Chrome (`localhost:3000/hq`) | — | Live data shown, light and dark themes work, no console errors |

No test was changed.

## Files modified (8)

| File | What changed |
|---|---|
| `src/app/globals.css` | DESIGN.md tokens for light and dark: canvas, surfaces, hairlines, text greys, primary `#DF2531`, and semantic colours with AA text shades. Also chart tokens; radii 8 / 12 / 16 / 24 px; Inter features; the `rail` variant (tablet rail or collapsed desktop); and a rule that keeps printed stickers on their original fonts |
| `src/app/layout.tsx` | Inter + JetBrains Mono through `next/font/google`, self-hosted at build time with no npm package; browsers never contact Google. Open Sans stays loaded for sticker sheets |
| `src/components/ui.tsx` | Restyled `PageTitle` (label-caps eyebrow, 28/22 px headline), `Card` (16 px radius, neutral icon tile), `Button` (8 px radius, lighter primary shadow), `Table` (label-caps heads, rounded panel), `Code` (mono 500), `Empty`, `Stat` (neutral icon tile, 4 px tone bar, tinted hint chip, quiet zero). Two optional props added: `Table.align` and `Stat` tone `"ok"`. No existing prop changed |
| `src/components/charts.tsx` | Bars: neutral charcoal series, value above each bar, mono axis, readable 2-line labels. Donut: track token, divided legend with mono figures. Meters: hairline rows, with a slim bar only for counts above 0 |
| `src/components/Sidebar.tsx` | 240 px desktop; 68 px icon rail on tablets (768–1023 px) and when collapsed on desktop; drawer below 768 px. Neutral active pill with a red dot and red icon (screen.png). New profile footer card |
| `src/components/AppHeader.tsx` | One 56 px frosted bar holding the breadcrumb, the signed-in user chip with an account panel, Account / Sign out (or the development Role / User switcher) and the theme switcher. The Operator `DeviceBar` row is unchanged |
| `src/app/(screens)/layout.tsx` | Suspense placeholder widths for the new sidebar sizes; main padding |
| `src/app/(screens)/hq/page.tsx` | Stitch layout. KPI shelf 5 columns from 1280 px, 3 + 2 on tablets, 2 on phones. Charts 8 + 4. Alerts row of three from 1280 px. Stock full width; In transit + Returns. Sentence-case labels; "Total" chip; skeleton and error states for Returns |

**Not touched:** `src/app/api/**`, `src/lib/**`, `session.tsx`, `useApi.ts`, `useAction.ts`, `themeScript.ts`, `RoleGate.tsx`, `menu.ts`, `ActAs.tsx`, `DeviceBar.tsx`, `Stickers.tsx`, `PrintView.tsx`, `src/app/print/**`, `tests/**`, `package.json`, the lock file, `.env*`, `next.config.ts`.

## Functionality preserved (verified)

- **Data:**
  - `/api/dashboard` with the same calculations for all five KPIs, both charts, alert counts, status counts, stock and in-transit.
  - `/api/returns/report` unchanged.
  - Refresh button calls `reload` (seen in Chrome: a `/api/dashboard` request).
  - The 15-second poll still fires (seen).
- **Links:** "All alerts" → `/hq/alerts`; in-transit and return codes → `/hq/search?code=…`.
- **Test hooks:**
  - `returns-row` and `data-code` are kept.
  - The stock row's first cell is still the tier, as `row /^Super Stockist SS-1/` expects.
  - Exactly one `signed-in-user` element remains, with the user's name.
  - "Sign out" is still a visible button at every width.
  - `#app-sidebar`, `#app-menu-button` ("Open menu"), `aria-current="page"`, the menu labels in `nav a`, and the drawer's Escape / `inert` / focus trap are all unchanged.
- **Theme:** same `velza-theme` choice and script; dark stays the default; the theme radios are still "Light / Dark / System theme".
- **Print:** sticker sheets still compute to Open Sans and the system monospace (checked on a live print view), so printed output is unchanged.

## Loading and data states

- **Dashboard loading:** the skeleton now uses the same grid as the loaded page.
- **Returns card:** shows skeleton rows while loading; "Nothing has been taken back" only after a successful load; an error Notice if the request fails. It previously showed "Loading…" text and ignored errors.
- **Unchanged:** no polling, timing or request behaviour was changed.

## Responsive behaviour

| Width | Sidebar | Top bar | KPI shelf | Notes |
|---|---|---|---|---|
| ≥1280 | 240 px (collapsible to 68 px) | 56 px, development switcher inline | 5 across | Matches screen.png |
| 1024–1279 | 240 px (collapsible) | switcher moves into the account panel | 3 + 2 | Charts 7 + 5; alerts row 2 + full-width Counts |
| 768–1023 | 68 px icon rail with tooltips | 56 px | 3 + 2 | — |
| <768 | drawer ("Open menu") | 56 px; theme inside the account panel | 2 + full-width Alerts | Wide tables scroll inside their card, never the page |

## Design conflicts and decisions

See IMPLEMENTATION-MAP.md, items C1–C10. In short:

- **Colour and contrast:**
  - Primary is `#DF2531`.
  - Greys and semantic text colours use AA-contrast shades.
  - Dark stays the default theme.
  - Cards are solid rather than frosted.
  - Card radius is 16 px.
- **Layout:**
  - The KPI shelf uses 2 columns on phones.
  - Returns keeps all 10 existing columns.
  - The active nav item uses a neutral pill.
- **Stitch items not built, because they would invent data or add a feature:**
  - the presentation toolbar;
  - the HQ "Online · Synced" pill;
  - "Last updated";
  - the KPI trend hints;
  - the "Review lots" link.
- **One derived label added:** "All clear", shown when alerts = 0.

The tablet icon rail starts at 768 px and ends at 1024 px. DESIGN.md calls 768–1279 px "tablet"; from 1024 px the full sidebar fits, and users can still collapse it.

## Effect on other screens (expected)

All signed-in screens now use the new tokens, fonts, sidebar, top bar and restyled primitives (cards, tables, buttons, stats). Their layouts and content were not redesigned. The sweep found no overflow or errors on any role's screens.

## Screenshots

**Before** (`docs/ui-baseline/`):
- `HQ0001_hq.dark.png`
- `HQ0001_hq.light.png`
- `HQ0001_hq.mobile.png`

**After** (`docs/ui-redesign/stitch/hq-dashboard/after/`):
- `hq.{light,dark}.{desktop,laptop,tablet-landscape,tablet,mobile}.png`
- `hq.dark.account-panel.png`
- `hq.dark.mobile-drawer.png`
- `other.operator-new.dark.png`
- `other.ss-receive.mobile.png`

**Approved design:** `screen.png`.

## Remaining issues and notes

1. **Network needed at build time.** `next/font/google` downloads Inter and JetBrains Mono during `next build` and `next dev`. Vercel has network access, so this works there; a fully offline build would need the font files added locally instead.
2. **Next.js dev badge.** The "N" badge and "Compiling…" toast in the screenshots belong to the Next.js dev server and do not appear in production.
3. **Known issue, unchanged.** `tests/qa/qaUi.mjs` still expects a "Dispatch" menu item for the Operator. This is the same pre-existing stale script as before.
4. **Other screens.** The "Nothing yet" loading flash is fixed on the HQ dashboard only. The same issue on AdminCrud, Receive returns and My partners belongs to those screens' steps.
5. **Nothing committed or pushed.**
