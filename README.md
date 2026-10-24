# Velza Barcode Traceability — Prototype

Web prototype of Velza's code generation and lot traceability system
(Manufacturer → Super Stockist → Distributor → Supplier → Outlet).

## Requirements

- Node.js 24 LTS (npm 11)

## Run

```bash
npm install
npm run seed      # reset demo data (data/db.json)
npm run dev       # http://localhost:3000
npm test          # unit tests (vitest)
```

## Folder layout

| Path | What lives there |
|---|---|
| `src/lib/core` | Pure business rules: code formats, allocation, status/movement rules, alerts |
| `src/lib/store` | `Store` interface + JSON-file implementation (`data/db.json`) |
| `src/lib/services` | Application services: load from the store, call core rules, persist |
| `src/app/api` | Route handlers (zod-validated) that call services |
| `src/app/(screens)` | Role screens |
| `src/components` | Shared UI components |
| `scripts` | `seed.ts` |
