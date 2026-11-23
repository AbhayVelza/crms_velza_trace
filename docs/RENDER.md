# Live link on Render

The app runs on Render's **free** web plan, and the data lives in a **paid** Render PostgreSQL database (`basic-256mb`, Singapore).
The database is paid on purpose: a free Render database is deleted 30 days after it is created, with all its data.
The paid one is kept for as long as the plan is paid, so batch codes such as DH3493 and their history stay available.

Everything is described in [`render.yaml`](../render.yaml) (a Render Blueprint).

## 1. Create the services (once)

1. Render dashboard → **New → Blueprint** → connect the GitHub repository `AbhayVelza/crms_velza_trace`.
2. Pick the branch. Use `main` once the Docker files are merged into it; until then `develop/abhay`.
3. Render shows two resources: `velza-trace` (web, Free) and `velza-db` (PostgreSQL, Basic 256 MB, paid). Approve.
   The paid database needs a card on the Render workspace.
4. Wait for the first deploy. The app's address is shown on the `velza-trace` page, e.g. `https://velza-trace.onrender.com`.

The app creates its tables by itself on first use. To bring existing data, do step 2 **before** anyone signs in.

## 2. Copy existing data into the Render database

Take the database's **External Database URL** (`velza-db` → Connect). Then, from a computer with PostgreSQL 17's tools:

```bash
pg_dump --format=custom --no-owner --no-privileges --dbname="$LOCAL_DATABASE_URL" --file=velza.dump
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RENDER_EXTERNAL_DATABASE_URL" velza.dump
```

Restart `velza-trace` afterwards (Manual Deploy → Restart service) so it reads the copied data.
Sign-ins come with the data: everyone keeps the sign-in ID and password they had.

## 3. Keep the app awake

A free web service sleeps after 15 minutes without visitors, and the next visitor then waits about a minute.
The workflow [`keep-render-awake.yml`](../.github/workflows/keep-render-awake.yml) visits `/login` every 10 minutes:

- Set the repository variable `RENDER_APP_URL` to the app's address (Settings → Secrets and variables → Actions → Variables).
- It runs only from `main`, and GitHub may start it late, so the app can still fall asleep sometimes.
  A free uptime monitor (UptimeRobot or cron-job.org, every 5 minutes, same `/login` URL) closes most of that gap.
- GitHub switches scheduled workflows off after 60 days without commits; re-enable it on the Actions tab.

One free service running all month uses about 744 of the workspace's 750 free hours, so keep only one free service awake.

## Known limits of this setup

- **Damage photos are not kept.** The free web plan has no lasting disk: photos are lost on every restart or deploy.
  Records of the damage stay (they are in the database); only the image files go.
- **Not for the plant line.** Sleeping, restarts and the small database suit people viewing the data through the link,
  not the plant's printing and scanning at 2 crore codes with no downtime. That needs paid, always-on hosting (docs/DEPLOYMENT.md).
- **Database access.** The database accepts connections from the internet (with its password). After the data copy,
  limit it under `velza-db` → Networking → Access Control to the addresses that need it; the app uses the internal address and is not affected.
