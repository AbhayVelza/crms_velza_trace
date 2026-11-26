@AGENTS.md

# Velza Barcode Traceability (CRMS) — project guide for Claude

Every unit (case, tray, pack) gets a barcode; each hand-over is scanned OUT/IN along
Manufacturer → Customs (Velza) → Super Stockist → Distributor → Retailer.
The full business rules live in `WORKING_MODEL.md` — read the relevant section before changing behaviour.

## Stack
- Next.js 16.4 (App Router, see AGENTS.md — this is NOT the Next.js in your training data), React 19, TypeScript, zod 4.
- API routes: `src/app/api/*` → services `src/lib/services/*` → pure rules `src/lib/core/*` → store `src/lib/store/*`.
- Store: `STORE=json | pglite | postgres`. PostgreSQL schema is code: `src/lib/store/sql/schema.ts` (`SCHEMA_VERSION`, currently 10).
- Tests: vitest (`npm test`, runs on JSON store and embedded Postgres), Playwright (`npm run test:e2e`).
- Infra: AWS Lightsail (Mumbai) via Terraform in `infra/terraform/`, Docker + Caddy in `deploy/`, GitHub Actions in `.github/workflows/`. Vercel/Render/Neon configs also exist for previews/testing. Details: `docs/DEPLOYMENT.md`, `docs/VERCEL.md`, `docs/RENDER.md`.

## Decisions to respect
- Pack/tray/case relationship: **Option C — packs follow their tray**.
- Live testing site currently runs on Supabase PostgreSQL. The final AWS database option is **not decided yet** — do not lock code to one provider; stay on plain PostgreSQL 16 features.
- DB roles: owner (migrations only), `velza_app` (no schema changes; `code_history` append-only), `velza_readonly`. See `db/roles.sql`.
- Security model in `SECURITY.md` (CSP, rate limits, role checks on every API call, parameterised SQL only).

## Go-live on AWS (design for review, Phase 1 done)
- Volume: **3,43,20,000 packs a year (3.43 crore PACKS, not trays/cases)** ≈ 57–86 lakh trays/cases, ≈ 4 crore barcodes, peak ≈ 35 requests/s, ≈ 70–85 GB DB growth a year. Older docs that say 3.43 crore trays/cases (peak 150/s, 400 GB/yr) are oversized.
- Follow these docs (they are the plan): `docs/GO_LIVE_ARCHITECTURE.md` (infra, `infra/aws/`), `docs/RELEASE_PIPELINE.md` (CI/CD), `docs/GO_LIVE_APP_CHANGES_AND_PLAN.md` (app changes C1–C11 + phases 2–11), `docs/DATABASE_GO_LIVE.md` + `docs/DATABASE_PHASE1_REVIEW.md` (database). PostgreSQL 17 on RDS is proposed (decision D1, not yet approved).
- Rehearse first in the DEMO AWS account (section 13 of GO_LIVE_ARCHITECTURE), then the real account. `infra/terraform/` stays as the Lightsail pilot.
- Agents never hold or ask for AWS passwords or access keys. Terraform is applied by GitHub Actions (OIDC + approval) or by Kailash himself.

## Rules for all agents
- Never commit or push to `main`; never force-push. Branch naming in `CONTRIBUTING.md`.
- Never touch production: no `terraform apply`, no deploy workflows, no `db:migrate` against a real database, no reading real `.env*` secrets. Prepare the change and tell the human what to run.
- A schema change = bump `SCHEMA_VERSION` + an in-place upgrade step + header comment in `schema.ts` + `npm run db:schema` (CI checks "upgrade = fresh install").
- Every behaviour change gets an entry in the `WORKING_MODEL.md` change log.
- Before saying "done": `npm run typecheck && npm run lint && npm test` (and `npm run build` for larger changes).

## Team of agents (`.claude/agents/`)
mentor · backend · frontend · database · devops · cloud · qa · reviewer. Ask **mentor** for the roadmap and "what next". The main session plans and delegates; **reviewer runs last on every change** and its verdict is reported to the human.
