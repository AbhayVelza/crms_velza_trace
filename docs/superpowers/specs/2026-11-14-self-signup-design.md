# Self sign-up for Super Stockists, Distributors and Retailers — design

Approved by the user on 14 Nov 2026 (approach A). Branch `develop/aditya`, not committed until the user says so.

## Why
Velza hands the app to SS, DB and Retailer shops; they create their own accounts. The Velza Admin creates sign-ins
only for the plant (Manufacturer Operator `-OP` and QC `-QC`) and for Velza's own accounts (Warehouse, HQ, staff).

## Decided by the user
- Retailers work as soon as they sign up; Super Stockists and Distributors need approval first.
- Everything about these sign-ins is stored in the database (the same store as partners and users).
- Approach **A**: the account is created at sign-up and locked until approved. Rejected: **B** (a separate request
  turned into an account on approval) — the shop would not know its sign-in ID until Velza told it.

## Design
1. `/signup` (public, linked from the sign-in page): type (SS / DB / Retailer), the Admin form's fields
   (site name, contact person, place, address, city, state, PIN, phone, email, password) and the place in the chain
   (SS: its state, one SS per state; DB: its SS; Retailer: its Distributor or, for a few, its SS). Only approved,
   active SS/DB are offered, as name + city.
2. The shop gets its ID at once (RT0003 …). Retailer: active immediately. SS/DB: saved with approval **Pending**,
   inactive; signing in says "Your account is waiting for Velza approval".
3. Admin → Partners: "Register a partner" offers Manufacturer and Velza Warehouse only; a **Pending approvals**
   card lists sign-ups with Approve / Reject. Approve activates partner and sign-in; Reject keeps the record
   (approval Rejected), the sign-in never works, the ID is not reused. A pending or rejected partner cannot be
   switched on with the Active box — only Approve does that.
4. Database: `partners.approval` — NULL (approved, all existing rows), `PENDING` or `REJECTED`; schema **v6**.
   A rejected SS no longer holds its state.
5. Safety: same password rules as today; sign-up limited per client IP; pending/rejected partners are inactive,
   so they cannot sign in, receive stock or appear in dispatch lists.

## Calls made by Claude (to confirm in the report)
- The Admin-only API (`POST /api/admin/partners`) can still create SS/DB/Retailers (data import and existing
  tests/QA scripts); only the Admin **form** is limited.
- Sign-up rate limit: 5 sign-ups per client IP per hour.
- Not built: email/SMS verification, notifying the Admin (the Pending approvals card shows a count).
- `features/barcode-history` also uses schema v6 (Returns): whoever merges the two renumbers one.
