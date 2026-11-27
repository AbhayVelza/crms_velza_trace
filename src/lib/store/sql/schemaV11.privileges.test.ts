// The database roles of schema v11 on embedded PostgreSQL, set up as on RDS / Lightsail: a NON-superuser owner
// (velza_owner) applies the schema and runs deploy/roles_v11.sql (twice: it is re-run on every deploy); then, signed in
// as velza_app, the SQL check files a human runs with psql against a test database:
//   tests/sql/test_v11_life_of_a_tray.sql  Option C, partitions, damage photos, operations objects (34 checks)
//   tests/sql/test_v11_privileges.sql      velza_app cannot change or remove history or evidence in any way (34 checks)
// and the app itself (SqlStore) working as velza_app, which has no right to change the schema.
//
// "SET SESSION AUTHORIZATION" makes the role the session user (as a real login), so "SET ROLE velza_owner" is refused to
// velza_app exactly as on a server.

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Partner } from "@/lib/core/types";
import { runPsqlScript, type ScriptDb } from "../../../../tests/fixtures/psqlScript";
import { createPgliteDriver, type SqlDriver } from "./driver";
import { SCHEMA_SQL } from "./schema";
import { SqlStore } from "./sqlStore";

const root = process.cwd();
const file = (...p: string[]) => path.join(root, ...p);
const PASSWORDS = { app_password: "TestApp2026pass", readonly_password: "TestRo2026pass" };

let d: SqlDriver;
let script: ScriptDb;
const as = (role: "velza_owner" | "velza_app" | "velza_readonly" | null) => d.exec(role ? `SET SESSION AUTHORIZATION ${role}` : `RESET SESSION AUTHORIZATION`);

beforeAll(async () => {
  d = await createPgliteDriver();
  script = { exec: (sql) => d.exec(sql), query: async (sql) => ({ rows: await d.query(sql) }) };
  // The server's master user (here the embedded superuser) creates the owner and gives it the database
  // (db/bootstrap_aws.sql on AWS); everything after that runs as the owner.
  const [{ db }] = await d.query<{ db: string }>(`SELECT current_database() AS db`);
  await d.exec(`CREATE ROLE velza_owner LOGIN CREATEROLE; ALTER DATABASE "${db}" OWNER TO velza_owner;`);
  await as("velza_owner");
  await d.exec(SCHEMA_SQL);
});
afterAll(async () => {
  await d.close();
});

describe("schema v11 roles (deploy/roles_v11.sql), as on a managed server", () => {
  it("the owner is not a superuser and owns every table and function of the app", async () => {
    expect(await d.query(`SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su`)).toEqual([{ u: "velza_owner", su: false }]);
    expect(await d.query(`SELECT DISTINCT tableowner AS o FROM pg_tables WHERE schemaname = 'public'`)).toEqual([{ o: "velza_owner" }]);
  });

  it("the roles file runs as the owner, and again (every deploy runs it)", async () => {
    await runPsqlScript(script, file("deploy", "roles_v11.sql"), PASSWORDS);
    await runPsqlScript(script, file("db", "roles.sql"), PASSWORDS); // includes deploy/roles_v11.sql
    const roles = await d.query<{ rolname: string; rolsuper: boolean; rolcreaterole: boolean; rolconfig: string[] | null }>(
      `SELECT rolname, rolsuper, rolcreaterole, rolconfig FROM pg_roles WHERE rolname IN ('velza_app', 'velza_readonly') ORDER BY 1`,
    );
    expect(roles.map((r) => [r.rolname, r.rolsuper, r.rolcreaterole])).toEqual([
      ["velza_app", false, false],
      ["velza_readonly", false, false],
    ]);
    expect(roles[0].rolconfig).toEqual(expect.arrayContaining(["statement_timeout=30s", "lock_timeout=10s", "idle_in_transaction_session_timeout=60s"]));
    // At most 100 connections for the app and jobs (RDS max_connections 150; DATABASE_GO_LIVE §2).
    expect(await d.query(`SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname IN ('velza_app', 'velza_readonly') ORDER BY 1`)).toEqual([
      { rolname: "velza_app", rolconnlimit: 100 },
      { rolname: "velza_readonly", rolconnlimit: -1 },
    ]);
    expect(roles[1].rolconfig).toEqual(expect.arrayContaining(["statement_timeout=120s", "default_transaction_read_only=on"]));
    // Every history partition, the guard table and the evidence tables: insert and read only for the app.
    const rights = await d.query<{ t: string; ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(
      `SELECT c.relname AS t, has_table_privilege('velza_app', c.oid, 'INSERT') AS ins, has_table_privilege('velza_app', c.oid, 'UPDATE') AS upd,
              has_table_privilege('velza_app', c.oid, 'DELETE') AS del, has_table_privilege('velza_app', c.oid, 'TRUNCATE') AS trunc
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
          AND (c.relname LIKE 'code_history%' OR c.relname IN ('damage_reports', 'attachments'))`,
    );
    expect(rights.length).toBeGreaterThanOrEqual(9); // parent, default, 4 months, guard, 2 evidence tables
    for (const r of rights) expect(r, r.t).toMatchObject({ upd: false, del: false, trunc: false });
    expect(rights.find((r) => r.t === "code_history")).toMatchObject({ ins: true });
    // The served-reprint guard: read only for the app; only its owner-rights trigger writes it.
    expect(rights.find((r) => r.t === "code_history_once")).toMatchObject({ ins: false });
    // Only the two owner-rights functions meant for the app can be called by it.
    const exec = await d.query<{ f: string; ok: boolean }>(
      `SELECT p.proname AS f, has_function_privilege('velza_app', p.oid, 'EXECUTE') AS ok FROM pg_proc p
        WHERE p.proname IN ('code_history_ensure_partitions', 'velza_daily_maintenance', 'code_history_create_month', 'code_history_repair_default') ORDER BY 1`,
    );
    expect(exec).toEqual([
      { f: "code_history_create_month", ok: false },
      { f: "code_history_ensure_partitions", ok: true },
      { f: "code_history_repair_default", ok: false },
      { f: "velza_daily_maintenance", ok: true },
    ]);
  });

  it("the life of a tray, as velza_app (tests/sql/test_v11_life_of_a_tray.sql)", async () => {
    await as("velza_app");
    try {
      await runPsqlScript(script, file("tests", "sql", "test_v11_life_of_a_tray.sql"));
    } finally {
      await as("velza_owner");
    }
  });

  it("velza_app cannot change or remove history or evidence in any way (tests/sql/test_v11_privileges.sql)", async () => {
    await as("velza_app");
    try {
      await runPsqlScript(script, file("tests", "sql", "test_v11_privileges.sql"));
    } finally {
      await as("velza_owner");
    }
    // The owner still can (archive a month, reset a test site): that is why its password is only there during deploys.
    await expect(d.exec(`TRUNCATE code_history_default`)).resolves.toBeUndefined();
  });

  it("velza_readonly reads, and can't write even after switching its read-only default off (the grants are the protection)", async () => {
    await as("velza_readonly");
    try {
      expect(await d.query(`SELECT count(*)::int AS n FROM partners`)).toEqual([{ n: 6 }]);
      await d.exec(`SET default_transaction_read_only = off`);
      await expect(d.exec(`INSERT INTO settings (id, data) VALUES ('x', '{}')`)).rejects.toThrow(/permission denied/);
      await expect(d.exec(`UPDATE partners SET name = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(d.exec(`INSERT INTO code_history (event_id, record_type, code, event, event_time) VALUES (gen_random_uuid(), 'SCAN', 'X', 'SCANNED', now())`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(d.query(`SELECT velza_daily_maintenance()`)).rejects.toThrow(/permission denied/);
    } finally {
      await as("velza_owner");
    }
  });

  it("the app (SqlStore) works as velza_app with no right to change the schema, including its own history-month upkeep", async () => {
    await as("velza_app");
    try {
      const store = new SqlStore(async () => d, null, { stockRollupIntervalMs: 0 });
      const shop: Partner = { id: "RT0009", type: "RETAILER", name: "Shop", place: "", address: "", city: "", state: "MH", pincode: "", contactPerson: "", phone: "", email: "", parentId: null, active: true, approval: null, createdAt: new Date().toISOString(), createdBy: null };
      await store.partners.create(shop);
      const m = await store.appendScan({ context: "RECEIVE", code: "91ZZZ999OR00001", ok: false, result: "UNKNOWN_CODE", message: "Unknown", userId: null, partnerId: "RT0009", deviceId: null });
      expect(await store.scans.list({ id: m.id })).toHaveLength(1);
      // Serving a reprint still works for the app (the guard's trigger writes code_history_once with the owner's
      // rights), and a second use is refused.
      const served = { type: "REPRINT_SERVED" as const, itemKind: "LOT" as const, itemCode: "91ABC123LM00001", fromId: null, toId: null, fromStatus: null, toStatus: null, userId: null, deviceId: null, invoice: null, note: null };
      const id = crypto.randomUUID();
      await store.movements.append({ ...served, id, at: new Date().toISOString() });
      await expect(store.movements.append({ ...served, id, at: new Date(Date.now() + 1000).toISOString() })).rejects.toMatchObject({ code: "23505" });
      await store.stockRollupIdle(); // the rollup and code_history_ensure_partitions(), as velza_app
      await expect(store.migrate({ force: true })).rejects.toThrow(/must be owner|permission denied/);
    } finally {
      await as("velza_owner");
    }
  });
});
