# Self sign-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SS / DB / Retailer shops create their own accounts at `/signup`; Retailers work at once, SS / DB wait for Admin approval.

**Architecture:** A nullable `approval` field on partners (`PENDING` | `REJECTED`, null = approved) plus the existing `active` flags: a pending or rejected partner and its sign-in are inactive, so every existing "active only" check (sign-in, dispatch lists, assignment) already excludes them. New service `src/lib/services/signup.ts`; approval actions in `admin.ts`.

**Tech Stack:** Next.js 16 app router, TypeScript, zod, vitest (json + postgres store contract), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-self-signup-design.md`

## Global Constraints
- Branch `develop/aditya`; **no commits** (user: test in the browser, then report).
- Schema version 6 (`SCHEMA_VERSION = 6`), idempotent `ADD COLUMN IF NOT EXISTS`.
- Messages, exact: pending sign-in → `Your account is waiting for Velza approval`; rejected → `This sign-up was not approved. Contact Velza.`
- Sign-up limit: 5 per client IP per hour (`RateLimiter(5, 3_600_000)`).
- Record WORKING_MODEL.md change-log row + affected section.

## Review Focus
1. An SS signing up for a state whose SS was **rejected** → allowed (rejected no longer holds the state).
2. A Retailer picking a **pending** DB as parent → refused `BAD_PARENT` (only approved, active parents).
3. Admin ticking **Active** on a pending partner → refused `NOT_APPROVED`.
4. Approving twice / approving a non-pending partner → refused `NOT_PENDING`.
5. Sign-up with `type: "MANUFACTURER"` or `"WAREHOUSE"` → refused (zod enum).

---

### Task 1: Data model + schema v6
**Files:** `src/lib/core/types.ts` (Partner), `src/lib/store/sql/schema.ts`, `src/lib/store/sql/sqlStore.ts` (partners cols), `src/lib/services/admin.ts` (validatePartner STATE_TAKEN skips REJECTED)
- [ ] `Partner.approval?: PartnerApproval | null` with `export type PartnerApproval = "PENDING" | "REJECTED"`.
- [ ] Column `approval text CHECK (approval IN ('PENDING','REJECTED'))` in CREATE TABLE and in the upgrade section; `partners_one_ss_per_state` recreated `WHERE partner_type = 'SS' AND approval IS DISTINCT FROM 'REJECTED'`; v6 note; mapping `["approval", "approval"]`.
- [ ] Existing suite still green (`npx vitest run src/lib/store`).

### Task 2: Sign-up + approval services (TDD)
**Files:** create `src/lib/services/signup.ts`, modify `src/lib/services/admin.ts`, `src/lib/services/auth.ts`; test `tests/unit/signup.test.ts`
**Interfaces (produces):**
- `signupOptions(): Promise<{ statesTaken: string[]; superStockists: {id,name,city,state}[]; distributors: {id,name,city,parentId}[] }>`
- `signup(body: unknown): Promise<{ partner: Partner; loginId: string; pending: boolean; message: string }>` — body = registration fields, `type ∈ SS|DB|RETAILER`, `parentId` required for DB and RETAILER.
- `decideApproval(userId: string|null, partnerId: string, body: unknown /* {decision:"approve"|"reject"} */): Promise<{ partner: Partner; message: string }>`
- [ ] Tests: retailer → active, can `login`; DB → pending, `login` 403 `PENDING_APPROVAL` with exact message; approve → login ok; reject SS → login 403 `REJECTED`, state free for a new SS; Review Focus 2–5; non-admin `decideApproval` → 403.
- [ ] Run: FAIL (module missing) → implement → PASS.

### Task 3: API routes + proxy
**Files:** create `src/app/api/signup/route.ts` (GET options, POST signup with the 5/hour limiter), `src/app/api/admin/partners/[id]/approval/route.ts` (POST); modify `src/proxy.ts` (let `/signup` through without a cookie).
- [ ] Check the static route `/api/admin/partners/[id]/approval` wins over `[entity]/[id]` (typecheck + manual call).

### Task 4: UI
**Files:** create `src/components/AuthShell.tsx` (moved from login page), `src/app/signup/page.tsx`; modify `src/app/login/page.tsx` (link "Create an account"), `src/app/(screens)/admin/partners/page.tsx` (tiers MF + VW in the form; Pending approvals card; status shown in table).
- [ ] typecheck, eslint clean.

### Task 5: Verify
- [ ] Full unit suite, typecheck, lint, Playwright e2e.
- [ ] Prod build on :3500 with a copy of `data/db.json`; browser: Retailer signs up → works; DB signs up → pending message → Admin approves → works and appears in dispatch list; SS rejected → refused; Admin form tiers; Active box refused on pending.
- [ ] WORKING_MODEL.md row; report to the user. No commit.
