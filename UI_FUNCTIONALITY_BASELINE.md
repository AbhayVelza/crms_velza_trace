# UI Functionality Baseline

Recorded on 20 Nov 2026, **before any redesign change**. The state is branch `develop/aditya` at HEAD `b7b8e91`, with no source changes in the working tree.
After every redesign step, the results must match this file. A difference counts as a regression unless it is explained in [UI_REDESIGN_TRACKER.md](UI_REDESIGN_TRACKER.md).

## Environment

- **Platform:** Windows 11, Node via npm scripts, and Chrome for the browser pass.
- **Dev app:** `npm run dev` on http://localhost:3000 with `STORE=pglite` and `PGLITE_DIR=data/pg`. This is the CRMS's own local database, used while Neon is over quota. Sign-in is turned off in development, so roles are switched with the dev sign-in.
- **E2E app:** a production build (`npm run build && next start -p 3100`) with its own JSON data in `data/e2e-db.json`. It does not touch the dev data.

## Automated checks

| Command | Result | Notes |
|---|---|---|
| `npm run lint` | ✅ pass, exit 0 | No warnings printed |
| `npx tsc --noEmit` | ✅ pass, exit 0 | |
| `npm test` (Vitest) | ✅ **938 passed, 9 skipped, 0 failed**, in 65 files | Took 296 s. The skipped tests are conditional, for example Postgres-only contract tests |
| `npx playwright test` (e2e) | ✅ **20 passed, 0 failed** | Took 7.0 min, including the production build |
| `npm run build` | ✅ succeeded | Run inside the e2e step |

**What the e2e tests cover.** Two spec files, run in this order:

- `demo.spec.ts` (tests 0–12):
  - each role sees only its own portal;
  - the operator creates a print order with a 7-step wizard, prints it, and the barcodes scan back;
  - QC verifies the lots;
  - a container goes to Customs, which receives and clears it;
  - SS receives the stock and a WRONG_RECEIVER alert is raised;
  - stock moves SS → DB → Retailer and the retailer opens a lot;
  - HQ search shows the timeline;
  - Product details is checked for each role;
  - an unknown code, a recall, and the public page saying "Recalled";
  - offline mode and sync;
  - a reprint, a damaged report, self sign-up with approval, and a password change;
  - container load and dispatch.
- `scanning.spec.ts` (tests 15–20):
  - the camera and USB-scanner flows, duplicates, and refused camera permission;
  - the camera is released when leaving the page;
  - at phone width, nothing scrolls sideways;
  - the dispatch and receive checklists.

**Existing issues found. Recorded only, not fixed:**

- **Stale QA script.** `tests/qa/qaUi.mjs` expects "Dispatch" in the Operator menu, but the menu has shown "Containers" since 16 Nov 2026. This script is not part of `npm test` or the e2e run.
- **"Nothing yet" shows while loading.** The empty-state message appears while the first fetch is still running on AdminCrud tables, the Receive returns table and My partners.
- **Production security warning.** The production server logs `CLIENT_IP_HEADER is not set`. This is a deployment setting, not a UI issue.

## Browser pass (dev app)

The capture script signed in as each role, opened every menu route, and took three screenshots of each:

- full-page dark at 1440 px;
- full-page light at 1440 px;
- dark at 390 px phone width.

**Result: 41 screens loaded with no page errors and no console errors.**

Screenshots are in `docs/ui-baseline/`, named `<user>_<route>.<dark|light|mobile>.png`, plus `public_login.png` and `public_signup.png`. They are not committed; see decision D5 in the tracker.

**Dev-only artefacts in the screenshots.** These are not product issues:

- the Next.js "N" dev badge and "Compiling…" toast in the bottom-left corner;
- the role and user selects in the header. Production shows Account and Sign out there instead.

**Sidebar in full-page screenshots.** The sidebar is `sticky` and `h-screen`, so in full-page screenshots it appears to stop at the first 900 px. In the real browser it stays in place while the page scrolls.

### Page load times (dev server, Turbopack, PGlite)

Time to network idle on navigation, in milliseconds. Each value includes Turbopack compiling the route on first visit, so these numbers show dev-server behaviour. They are not production speed.

| Role (user) | Route → ms |
|---|---|
| Admin (AD0001) | `/` 5210 · `/admin/partners` 3561 · `/admin/users` 5552 · `/admin/devices` 4272 · `/admin/reference` 4429 · `/admin/pools` 3999 · `/admin/settings` 4987 · `/details` 5096 · `/account` 11993 |
| HQ (HQ0001) | `/` 2767 · `/hq` 7056 · `/hq/search` 11465 · `/hq/alerts` 3927 · `/hq/batches` 8831 · `/containers` 13526 · `/hq/scans` 8391 |
| Operator (MF0001-OP) | `/` 4676 · `/operator/new` 3559 · `/operator/orders` 3530 · `/containers` 3783 · `/operator/reprint` 12159 · `/operator/void` 11502 · `/stock` 3801 · `/damaged` 9756 |
| QC (MF0001-QC) | `/qc/verify` 9360 |
| Customs (VW0001) | `/` 3107 · `/receive` 3901 · `/containers` 3528 · `/dispatch` 13962 · `/stock` 3386 |
| Super Stockist (SS0001) | `/` 3329 · `/receive` 4934 · `/dispatch` 4875 · `/stock` 3922 · `/my-partners` 10507 · `/damaged` 4371 |
| Distributor (DB0001) | `/` 3117 · `/my-partners` 2558 |
| Retailer (RT0001) | `/` 3146 · `/open-lot` 7559 · `/stock` 3060 |

The 10–14 s values are first-time route compiles. Earlier warm measurements in this project were 0.1–1.0 s per tab. For a fair before/after comparison, measure again on a warm server or on a production build.

### Responsive sweep

The existing script checks every role's routes at 9 widths (320, 375, 390, 430, 768, 1024, 1280, 1440 and 1920 px). It looks for page-level sideways scrolling and for elements that stick out of the viewport.

**Last result: no problems.** The same script is used after each redesign step.

## Key workflows to re-check by hand after each step

1. **Operator:** New print order (7 steps) → Create & print → print view → Mark as printed.
2. **QC:** Verify a lot (scan the lot, then every pack, then Confirm → PACKED). Also quarantine a lot.
3. **Operator:** Container: create it, load it, dispatch it to Customs.
4. **Customs:** receive the container by its number, then Mark cleared with a Bill of Entry.
5. **SS:** Receive (checklist ticks), then Dispatch to a DB with an invoice.
6. **Retailer:**
   - Receive, then Open lot.
   - Damaged report with photo upload.
7. **HQ:**
   - Dashboard charts.
   - Search a code (timeline).
   - Alerts: acknowledge an alert.
   - Batch report and two-step recall.
8. **Admin:** register a partner, approve a sign-up, edit an inline cell (it saves on blur), and set a password.
9. **Every role:**
   - theme switch (light, dark, system);
   - sidebar collapse and the phone drawer;
   - a page outside the role's portal shows "This page is not part of the … portal".
10. **Public:**
    - `/t/<code>` shows the genuine or recalled status.
    - `/login` and `/signup`.
