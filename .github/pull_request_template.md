## What changed

<!-- What does this PR do, and why? Link the issue or task if there is one. -->

## How to test it

<!-- Steps a reviewer can follow on the preview deployment: which sign-in (role), which screens, what to scan or enter, what should happen. -->

1.
2.

## Vercel preview

<!-- Vercel comments the preview link on this PR. Paste it here once it is ready. -->

Preview:

## Checklist

- [ ] The branch is named `feature/<name>-<topic>`, `fix/<name>-<topic>` or `chore/<name>-<topic>`
- [ ] `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass locally
- [ ] I tested the change on the Vercel preview
- [ ] No secrets, `.env*` files (other than `.env.example`) or `data/` files are committed
- [ ] Schema change? `SCHEMA_VERSION` is bumped, the upgrade step is added, and `npm run db:migrate` must run against production before merging (see docs/VERCEL.md)
- [ ] New environment variable? It is in `.env.example` and docs/VERCEL.md, and set in Vercel for Production and Preview
- [ ] Docs (README, SECURITY.md, docs/) are updated if behaviour changed
