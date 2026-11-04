# Manual sign-in test guide (sign-in ON)

29 Oct 2026, updated 30 Oct 2026 · for testing sign-in and every role by hand in the browser. Background:
`WORKING_MODEL.md` Part 5. No passwords are written here.

**Current setting (30 Oct 2026): sign-in is temporarily OFF** (`SIGN_IN=off` in `.env.local`). Opening
http://localhost:3000 shows the Velza Admin Overview directly (acting as AD0001, no password); `/login` redirects
there. The Role/User selects in the header switch to any other person. `SIGN_IN=off` is for local development and
testing only. Never use it on a server: everyone who reaches the app is Velza Admin. To run this guide, switch sign-in
on first (§1).

## 0. Before you start

**Where the passwords are**

| Sign-ins | Password |
|---|---|
| AD0001 (Velza Admin), HQ0001 (Velza HQ) | The passwords printed by the `npm run seed` run at 12:02 IST on 29 Oct 2026 (the ones you signed in with afterwards). The partner restore kept them. |
| MF0001-OP, MF0001-QC, SS0001–SS0002, DB0001–DB0005, RT0001–RT0010 | `partnerPassword` in `data/qa-mh-2026-credentials.json` (git-ignored). Open it in your editor; don't paste it into chats, tickets or screenshots. |

Lost the AD0001 or HQ0001 password? **Don't run `npm run seed`** — it wipes every partner and sign-in (this is what
caused "Partners (0)" on 29 Oct; see `WORKING_MODEL.md` Part 5). Set `SIGN_IN=off` in `.env.local`, pick
open http://localhost:3000 (it opens as Velza Admin), open **Sign-ins & passwords**, set new passwords for
AD0001/HQ0001, then set `SIGN_IN=on` again.

**Careful:** 5 wrong passwords lock that sign-in ID for 5 minutes (restarting the server clears it). Test lockout
only with RT0010.

**Accounts (21)**

| Role | Sign-in IDs | Assigned partners |
|---|---|---|
| Velza Admin | AD0001 | — |
| Velza HQ | HQ0001 | — |
| Manufacturer Operator | MF0001-OP | plant MF0001, dispatches to SS0001, SS0002 |
| Supervisor / QC | MF0001-QC | plant MF0001 |
| Super Stockist | SS0001 (Pune), SS0002 (Goa) | SS0001 → DB0001, DB0002, DB0003 · SS0002 → DB0004, DB0005 |
| Distributor | DB0001–DB0005 | DB0001 → RT0001, RT0002 · DB0002 → RT0003, RT0004 · DB0003 → RT0005, RT0006 · DB0004 → RT0007, RT0008 · DB0005 → RT0009, RT0010 |
| Retailer | RT0001–RT0010 | — |

## 1. Start the app with sign-in on

1. In `.env.local` in the project folder, change `SIGN_IN=off` to `SIGN_IN=on` and save. Then sign out once in each
   browser that used the Role/User selects (their sessions stay valid otherwise, AUTH-1).
2. If `npm run dev` is already running, it has picked this up. Otherwise run `npx next dev -H 127.0.0.1` (this PC
   only); plain `npm run dev` also works but can be reached from other PCs on the network.
3. Open http://localhost:3000. Expect a redirect to `/login`.

## 2. The sign-in page

Expect: the black brand panel on the left (wide screens), and a **Sign in** card with *Sign-in ID* and *Password*.
**No** "Choose who you are" list, no Role/User selects. The Sign in button is greyed out until both fields are filled.
Theme buttons at the top right work.

Defect if: you land in a portal without signing in, or the "Choose who you are" picker shows.
(If an old browser session is still around, sign out or clear the site cookies once.)

## 3. Each role

For each sign-in: sign in → check the header, sidebar and start page → open each menu item → sign out (header,
right) → you are back on `/login`.

| Sign in as | Sidebar must be exactly | Also check |
|---|---|---|
| AD0001 | Partners · Sign-ins & passwords · Devices · Countries & flavours · Batch code pools · Settings | Partners lists 18 partners; Sign-ins lists 21 |
| HQ0001 | Dashboard · Search code · Alerts · Batches & recall · Scan audit | Dashboard loads; Scan audit is empty (the re-seed cleared it) apart from scans you make |
| MF0001-OP | New print order · Print orders · Dispatch · Reprint · Void lot · My stock · Damaged | Device status row under the header; Dispatch offers only SS0001 and SS0002 |
| MF0001-QC | Verify · My stock | No Operator pages in the menu |
| SS0001 | Receive · Dispatch · My stock · Damaged · My partners | My partners and Dispatch show only DB0001, DB0002, DB0003 |
| SS0002 | same as SS0001 | Only DB0004, DB0005 |
| DB0001 (and DB0002–DB0005) | Receive · Dispatch · My stock · Damaged · My retailers | My retailers and Dispatch show only its 2 retailers (table above) |
| RT0001 (and others) | Receive · Open lot · My stock · Damaged | No Dispatch |

The header (middle) shows the person's name, the sign-in ID and the organisation; on the right **Account** and
**Sign out**. The live data has no stock yet, so stock pages are empty — that is expected.

## 4. Parent–child visibility and refused pages

1. As SS0001, open **My partners**: DB0004/DB0005 must not appear. As DB0001: RT0003–RT0010 must not appear.
2. As any partner, type http://localhost:3000/hq in the address bar → "This page is not part of the … portal".
   As HQ0001, open `/admin/partners` → the same message. As RT0001, open `/dispatch` → the same message.

## 5. Wrong passwords

1. Sign in as RT0001 with a wrong password → "Wrong sign-in ID or password", no sign-in.
2. Sign-in ID `ZZ9999` with any password → the same message (doesn't reveal which IDs exist).
3. RT0010: 5 wrong passwords, then the right one → "Too many wrong passwords — try again in 5 minute(s)".

## 6. Sign-out and session isolation

1. Sign in as DB0001, sign out, press the browser **Back** button → you stay on (or return to) `/login`.
2. Sign in as SS0001, sign out, sign in as RT0001 → menu and header show only RT0001; `/my-partners` is refused.
3. Two browsers (e.g. Edge and an Edge InPrivate window): SS0001 in one, DB0001 in the other → each keeps its own
   portal after reloading.
4. **Account** page: change RT0002's password, then sign out and sign in with the new one. (Then tell whoever keeps
   the QA credentials file, or change it back.)

## 7. Public QR page (no sign-in)

In a private window open http://localhost:3000/t/91AAAAAAOR00001 → the public check page opens without sign-in and shows
"Unregistered code". It shows no partner names, stock or invoices. Each public check is logged in HQ's Scan audit.

## 8. Optional: full chain with your own data

This writes real records to `data/db.json` (backup: `data/db.backup-2026-10-29-before-auth.json`).
AD0001 → Devices: register a PC for MF0001 → MF0001-OP: New print order, print → MF0001-QC: Verify → MF0001-OP:
Dispatch to SS0001 → SS0001: Receive, Dispatch to DB0001 → DB0001: Receive, Dispatch to RT0001 → RT0001: Receive,
Open lot → HQ0001: Search the lot code and see every step.

## 9. Evidence to keep

One screenshot per role (sidebar + header), the sign-in page, the "not part of the … portal" message, the
wrong-password and locked messages, and the public page. Before sharing, check that no password is visible.
Note the time, sign-in ID, URL and what you expected for anything that looks wrong.

## 10. Expected vs defect

| You see | Meaning |
|---|---|
| Console (F12): 404 for `/api/auth/dev-users` on every page | Known DEF-003, harmless |
| Console: 401 for `/api/auth/me` on the sign-in page | Expected (the page checks whether you're already signed in) |
| Stock, alerts, print orders empty | Expected: no stock in the live data yet |
| Another role's menu item, another partner's data, a portal without signing in, the act-as picker | **Defect** — report it |

## 11. Back to development mode (no data lost)

Change `.env.local` to `SIGN_IN=off` (or delete the line). The running dev server switches over; reload the page.
It opens on the Velza Admin Overview (AD0001) with no sign-in page; use the header's Role/User selects to test another
person. Data, sign-ins and passwords stay as they are. Checks for this mode: `/` and `/login` show the Overview, the
6 Admin menu pages open, reload stays, `/hq` shows "not part of the … portal". Anything you change as Admin in this
mode is recorded as AD0001. To switch sign-in back on later: `SIGN_IN=on`, then sign out once in
each browser that used the picker (sessions from picker mode stay valid for up to 12 h — AUTH-1).
