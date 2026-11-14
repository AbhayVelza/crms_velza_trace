# Connect PostgreSQL — step by step

The app already supports PostgreSQL. You only give it a connection string; screens and rules stay the same.
**Time:** about 20 minutes. **What changes:** one new file, `.env.local`. **What you gain:** up to 10,000 lots per
print order (1,000 on the JSON file), and several app servers can use the same data.

---

## Step 1 — Install PostgreSQL (once per PC/server)

1. Download the Windows installer: <https://www.postgresql.org/download/windows/> → "Download the installer"
   → version **17**.
2. Run it and keep the defaults. Two things to note:
   - **Password** for the `postgres` user → write it down.
   - **Port** → keep `5432`.
3. Untick "Stack Builder" at the end. It isn't needed.

> Using a hosted database (Neon, Supabase, AWS RDS) instead? Skip to Step 3 and use the connection string the
> provider gives you, which ends in `?sslmode=require`.

## Step 2 — Create the database

1. Start menu → **SQL Shell (psql)**.
2. Press **Enter** at each question (Server, Database, Port, Username) and type your password when asked.
3. Type:

   ```sql
   CREATE DATABASE velza;
   ```

   You should see `CREATE DATABASE`. Type `\q` to close.

## Step 3 — Tell the app where the database is

In `C:\barcode_generator`, create a file named **`.env.local`** containing one line:

```
DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/velza
```

- Replace `YOUR_PASSWORD` with the password from Step 1.
- If the password contains `@ : / ? # %`, write it encoded: `@`→`%40`, `:`→`%3A`, `/`→`%2F`, `?`→`%3F`,
  `#`→`%23`, `%`→`%25`.
- `.env.local` is never committed to git, so the password stays on this PC.

## Step 4 — Stop the app

Press **Ctrl+C** in the terminal where `npm run dev` is running.

## Step 5 — Create the tables

```
npm run db:migrate
```

You should see `Schema is up to date in …` and `Rows: 0 partners, 2 sign-ins, 0 codes, …`. On a first run it also
prints the passwords of those two sign-ins (Velza Admin and Velza HQ). Step 6 replaces them with your current users.

## Step 6 — Copy your current data across

```
npm run db:import-json
```

This copies everything in `data/db.json` (partners, users, flavours, settings, batch codes, orders) into PostgreSQL.
`data/db.json` itself is **not changed**, so it stays as your backup.

## Step 7 — Start the app

```
npm run dev
```

Check that it worked:
- Admin → Partners shows the same partners as before.
- New print order → Cases & trays says **at most 10,000 lots** per order.

---

## Go back to the JSON file

Put `#` in front of the `DATABASE_URL` line in `.env.local` and restart the app. The data in PostgreSQL stays where
it is.

## Back up the database

```
"C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -U postgres -d velza -f velza-backup.sql
```

## If something goes wrong

| Message | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL isn't running | Start menu → Services → start **postgresql-x64-17** |
| `password authentication failed` | Wrong password in `.env.local` | Fix it (check the special characters in Step 3) |
| `database "velza" does not exist` | Step 2 was skipped | Do Step 2 |
| `already has partners or codes` | Data was imported before | `npm run db:import-json -- --force` **replaces** the database with `db.json` |
| `No database configured` | `.env.local` isn't found or is misnamed | The file must be `C:\barcode_generator\.env.local` (no `.txt`) |
| `is in use by another process` | The app is still running | Step 4 |

## Before connecting: the temporary branch

You are on branch `temp-dh3493` ("several flavours per batch code, to be reverted"). Its tables differ from
`main` (schema v5). If that change will be reverted, connect PostgreSQL after deciding whether to keep it;
otherwise the database gets the temporary table layout.
