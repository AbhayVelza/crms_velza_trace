# Contributing

## Branches

Never commit or push to `main`. Start every change from the latest `main`:

```sh
git fetch origin
git switch -c feature/<name>-<topic> origin/main
```

| Prefix | For | Example |
|---|---|---|
| `feature/<name>-<topic>` | new behaviour | `feature/abhay-customs-export` |
| `fix/<name>-<topic>` | bug fixes | `fix/aditya-scan-timeout` |
| `chore/<name>-<topic>` | tooling, config, docs, dependencies | `chore/kailash-vercel-setup` |

## Pull requests

1. Push your branch and open a pull request into `main`. Fill in the template.
2. Vercel deploys every pull request to its own **preview** URL (with its own copy of the database) and comments
   the link on the PR. Test your change there, and paste the link into the PR.
3. CI runs typecheck, lint, tests, the build and the schema-upgrade check. All must be green.
4. One other team member reviews and approves.
5. Merge (squash is fine). The branch can then be deleted.

`main` is protected: no direct pushes, no force pushes, no merging without one approval and green CI.

## After merging

Every merge to `main` deploys to **production** on Vercel automatically. If your change bumps `SCHEMA_VERSION`,
run `npm run db:migrate` against the production database **before** merging (see [docs/VERCEL.md](docs/VERCEL.md)).

## Before you push

```sh
npm run typecheck && npm run lint && npm test && npm run build
```

Never commit secrets or real `.env` files: copy `.env.example` to `.env.local` (ignored by git) and use your own
development database, never the production one.
