// Store implementation over PostgreSQL. Each repo maps an app collection onto the schema
// (schema.ts): lots and packs are rows of the one `codes` table, movements, scans and reprints are
// rows of `code_history`. Field names stay the app's; column names are the database's.

import { LOT_NUMBER_MAX } from "@/lib/core/codes";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/core/types";
import { NotFoundError, type AppendOnlyRepo, type DbSnapshot, type NewMovement, type NewScan, type Repo, type Row, type Store, type StoreTx, type Where } from "../Store";
import type { Query, SqlDriver } from "./driver";
import { ALL_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

type ColType = "text" | "int" | "bool" | "ts" | "date" | "json" | "textarr";
type Col = [field: string, column: string, type?: ColType];

interface Spec {
  table: string;
  /** Primary key column (the app's `id`). */
  key: string;
  cols: Col[];
  /** Column values that pick this collection's rows out of a shared table (codes, code_history). */
  fixed?: Record<string, string>;
  /** Extra columns written on insert, derived from the row (and the database). */
  derive?: (rows: Record<string, unknown>[], q: Query) => Promise<Record<string, unknown>[]>;
  order: string;
}

const SETTINGS_ID = "default";
const INSERT_CHUNK = 200;

const castOf = (t: ColType | undefined) =>
  t === "ts" ? "::timestamptz" : t === "date" ? "::date" : t === "json" ? "::jsonb" : t === "textarr" ? "::text[]" : t === "int" ? "::integer" : t === "bool" ? "::boolean" : "";

/** SELECT expression giving the app's value: timestamps as ISO strings, dates as YYYY-MM-DD. */
const selectExpr = ([field, column, type]: Col) => {
  const expr =
    type === "ts"
      ? `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : type === "date"
        ? `to_char(${column}, 'YYYY-MM-DD')`
        : column;
  return `${expr} AS "${field}"`;
};

const toParam = (v: unknown, type: ColType | undefined) => (v === undefined ? null : type === "json" && v !== null ? JSON.stringify(v) : v);

// ---------------------------------------------------------------- collection specs

const T = (...cols: Col[]) => cols;

/** Code parts by position: country 0–2, batch 2–8, flavour 8–10, hex lot number 10–15, pack size 15, sequence 16. */
const parts = (code: string) => ({
  country_code: code.slice(0, 2),
  batch_code: code.slice(2, 8),
  flavour: code.slice(8, 10),
  hex_code: code.slice(10, 15),
  lot_number: parseInt(code.slice(10, 15), 16),
});

/** Batch columns copied onto each code row, so every row carries every field (looked up once per batch). */
async function batchInfo(q: Query, batchCodes: string[]) {
  const unique = [...new Set(batchCodes)];
  const rows = unique.length
    ? await q<{ batch_code: string; mfg_date: string; expiry_date: string; manufacturer_id: string; device_id: string; print_order_id: string; synced: boolean; created_by: string }>(
        `SELECT batch_code, to_char(mfg_date, 'YYYY-MM-DD') AS mfg_date, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
                manufacturer_id, device_id, print_order_id, synced, created_by
           FROM batches WHERE batch_code = ANY($1::text[])`,
        [unique],
      )
    : [];
  return new Map(rows.map((r) => [r.batch_code, r]));
}

const LOT_COLS = T(
  ["id", "code"],
  ["lotCode", "code"],
  ["batchCode", "batch_code"],
  ["flavour", "flavour"],
  ["lotType", "lot_type"],
  ["packSize", "pack_size", "int"],
  ["lotNumber", "lot_number", "int"],
  ["status", "status"],
  ["locationId", "location_id"],
  ["inTransitToId", "in_transit_to"],
  ["dispatchedAt", "dispatched_at", "ts"],
  ["printOrderId", "print_order_id"],
  ["manufacturerId", "manufacturer_id"],
  ["deviceId", "device_id"],
  ["synced", "synced", "bool"],
  ["quarantineReason", "quarantine_reason"],
  ["statusBeforeRecall", "status_before_recall"],
  ["createdAt", "generated_at", "ts"],
  ["updatedAt", "updated_at", "ts"],
);

const PACK_COLS = T(
  ["id", "code"],
  ["packCode", "code"],
  ["lotCode", "lot_code"],
  ["seq", "pack_sequence", "int"],
  ["packSize", "pack_size", "int"],
  ["status", "status"],
  ["locationId", "location_id"],
  ["inTransitToId", "in_transit_to"],
  ["dispatchedAt", "dispatched_at", "ts"],
  ["statusBeforeRecall", "status_before_recall"],
  ["createdAt", "generated_at", "ts"],
  ["updatedAt", "updated_at", "ts"],
);

const SPECS = {
  countries: { table: "countries", key: "id", order: "row_no", cols: T(["id", "id"], ["code", "code"], ["name", "name"], ["active", "active", "bool"]) },
  flavours: { table: "flavours", key: "id", order: "row_no", cols: T(["id", "id"], ["code", "code"], ["name", "name"], ["active", "active", "bool"]) },
  partners: {
    table: "partners",
    key: "partner_id",
    order: "row_no",
    cols: T(
      ["id", "partner_id"],
      ["type", "partner_type"],
      ["name", "name"],
      ["place", "place"],
      ["address", "address"],
      ["city", "city"],
      ["state", "state"],
      ["pincode", "pincode"],
      ["contactPerson", "contact_person"],
      ["phone", "phone"],
      ["email", "email"],
      ["parentId", "parent_id"],
      ["active", "active", "bool"],
      ["createdAt", "created_at", "ts"],
      ["createdBy", "created_by"],
    ),
  },
  users: {
    table: "users",
    key: "login_id",
    order: "row_no",
    cols: T(
      ["id", "login_id"],
      ["name", "name"],
      ["role", "role"],
      ["partnerId", "partner_id"],
      ["active", "active", "bool"],
      ["passwordHash", "password_hash"],
      ["passwordChangedAt", "password_changed_at", "ts"],
      ["createdAt", "created_at", "ts"],
      ["lastLoginAt", "last_login_at", "ts"],
    ),
  },
  sessions: {
    table: "sessions",
    key: "session_id",
    order: "row_no",
    cols: T(["id", "session_id"], ["userId", "login_id"], ["createdAt", "created_at", "ts"], ["expiresAt", "expires_at", "ts"]),
  },
  devices: {
    table: "devices",
    key: "device_id",
    order: "row_no",
    cols: T(["id", "device_id"], ["manufacturerId", "manufacturer_id"], ["name", "name"], ["offline", "offline", "bool"], ["lastSyncAt", "last_sync_at", "ts"]),
  },
  batchCodePool: {
    table: "batch_code_pool",
    key: "id",
    order: "row_no",
    cols: T(["id", "id"], ["code", "batch_code"], ["deviceId", "device_id"], ["status", "status"], ["issuedAt", "issued_at", "ts"], ["usedAt", "used_at", "ts"]),
  },
  batches: {
    table: "batches",
    key: "id",
    order: "row_no",
    cols: T(
      ["id", "id"],
      ["code", "batch_code"],
      ["country", "country_code"],
      ["flavour", "flavour"],
      ["mfgDate", "mfg_date", "date"],
      ["expiryDate", "expiry_date", "date"],
      ["manufacturerId", "manufacturer_id"],
      ["deviceId", "device_id"],
      ["nextLot", "next_lot", "int"],
      ["status", "status"],
      ["synced", "synced", "bool"],
      ["printOrderId", "print_order_id"],
      ["createdAt", "created_at", "ts"],
      ["createdBy", "created_by"],
      ["recalledAt", "recalled_at", "ts"],
      ["recallReason", "recall_reason"],
    ),
  },
  printOrders: {
    table: "print_orders",
    key: "print_order_id",
    order: "row_no",
    cols: T(
      ["id", "print_order_id"],
      ["createdAt", "created_at", "ts"],
      ["createdBy", "created_by"],
      ["deviceId", "device_id"],
      ["manufacturerId", "manufacturer_id"],
      ["batchCodes", "batch_codes", "textarr"],
      ["lotCodes", "lot_codes", "textarr"],
      ["stickerCount", "sticker_count", "int"],
      ["status", "status"],
      ["printedAt", "printed_at", "ts"],
      ["synced", "synced", "bool"],
    ),
  },
  lots: {
    table: "codes",
    key: "code",
    order: "row_no",
    fixed: { code_type: "LOT" },
    cols: LOT_COLS,
    async derive(rows, q) {
      const info = await batchInfo(q, rows.map((r) => String(r.batchCode)));
      return rows.map((r) => {
        const b = info.get(String(r.batchCode));
        const code = String(r.lotCode ?? r.id);
        const { country_code, hex_code } = parts(code);
        return { country_code, hex_code, lot_code: code, pack_sequence: null, mfg_date: b?.mfg_date ?? null, expiry_date: b?.expiry_date ?? null, generated_by: b?.created_by ?? null };
      });
    },
  },
  packs: {
    table: "codes",
    key: "code",
    order: "row_no",
    fixed: { code_type: "PACK" },
    cols: PACK_COLS,
    async derive(rows, q) {
      const info = await batchInfo(q, rows.map((r) => String(r.packCode ?? r.id).slice(2, 8)));
      return rows.map((r) => {
        const code = String(r.packCode ?? r.id);
        const p = parts(code);
        const b = info.get(p.batch_code);
        return {
          ...p,
          lot_type: Number(r.packSize) === 6 ? "CASE" : "TRAY",
          mfg_date: b?.mfg_date ?? null,
          expiry_date: b?.expiry_date ?? null,
          manufacturer_id: b?.manufacturer_id ?? null,
          device_id: b?.device_id ?? null,
          print_order_id: b?.print_order_id ?? null,
          synced: b?.synced ?? true,
          generated_by: b?.created_by ?? null,
        };
      });
    },
  },
  movements: {
    table: "code_history",
    key: "event_id",
    order: "history_id",
    fixed: { record_type: "MOVEMENT" },
    cols: T(
      ["id", "event_id"],
      ["at", "event_time", "ts"],
      ["type", "event"],
      ["itemKind", "item_kind"],
      ["itemCode", "code"],
      ["fromId", "from_id"],
      ["toId", "to_id"],
      ["fromStatus", "status_before"],
      ["toStatus", "status_after"],
      ["userId", "login_id"],
      ["deviceId", "device_id"],
      ["invoice", "invoice_no"],
      ["note", "reason"],
    ),
    // Where it was at that moment: the sender while it is being dispatched, otherwise where it ended up.
    derive: async (rows) => rows.map((r) => ({ location_id: r.type === "DISPATCHED" ? (r.fromId ?? null) : (r.toId ?? r.fromId ?? null), ok: true, result: "OK" })),
  },
  scans: {
    table: "code_history",
    key: "event_id",
    order: "history_id",
    fixed: { record_type: "SCAN" },
    cols: T(
      ["id", "event_id"],
      ["at", "event_time", "ts"],
      ["context", "context"],
      ["code", "code"],
      ["ok", "ok", "bool"],
      ["result", "result"],
      ["message", "message"],
      ["userId", "login_id"],
      ["partnerId", "location_id"],
      ["deviceId", "device_id"],
    ),
    derive: async (rows) => rows.map((r) => ({ event: r.ok ? "SCANNED" : "SCAN_FAILED" })),
  },
  reprints: {
    table: "code_history",
    key: "event_id",
    order: "history_id",
    fixed: { record_type: "REPRINT" },
    cols: T(["id", "event_id"], ["at", "event_time", "ts"], ["code", "code"], ["itemKind", "item_kind"], ["reason", "reason"], ["userId", "login_id"], ["deviceId", "device_id"]),
    derive: async (rows) => rows.map(() => ({ event: "REPRINTED", ok: true, result: "OK" })),
  },
} satisfies Record<string, Spec>;

type RepoName = keyof typeof SPECS;

// ---------------------------------------------------------------- generic repo

function makeRepo<R extends Row>(q: Query, spec: Spec): Repo<R> {
  const colOf = new Map(spec.cols.map((c) => [c[0], c]));
  const select = `SELECT ${spec.cols.map(selectExpr).join(", ")} FROM ${spec.table}`;
  const fixed = Object.entries(spec.fixed ?? {});

  function where(filter: Record<string, unknown> | undefined, params: unknown[]): string {
    const parts = fixed.map(([column, value]) => (params.push(value), `${column} = $${params.length}`));
    for (const [field, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      const col = colOf.get(field);
      if (!col) throw new Error(`${spec.table}: no column for field ${field}`);
      if (value === null) parts.push(`${col[1]} IS NULL`);
      else {
        params.push(toParam(value, col[2]));
        parts.push(`${col[1]} = $${params.length}${castOf(col[2])}`);
      }
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  const list = async (filter?: Where<R>) => {
    const params: unknown[] = [];
    return q<R>(`${select}${where(filter as Record<string, unknown>, params)} ORDER BY ${spec.order}`, params);
  };

  async function insert(rows: R[]) {
    if (!rows.length) return;
    const derived = spec.derive ? await spec.derive(rows as unknown as Record<string, unknown>[], q) : rows.map(() => ({}));
    // One column per distinct database column (id and lotCode both map to `code`).
    const columns: { column: string; type?: ColType; value: (r: Record<string, unknown>, d: Record<string, unknown>) => unknown }[] = [];
    const seen = new Set<string>();
    for (const [field, column, type] of spec.cols) {
      if (seen.has(column)) continue;
      seen.add(column);
      columns.push({ column, type, value: (r) => toParam(r[field], type) });
    }
    const add = (column: string, value: (r: Record<string, unknown>, d: Record<string, unknown>) => unknown) => {
      if (seen.has(column)) return;
      seen.add(column);
      columns.push({ column, value });
    };
    for (const [column, value] of fixed) add(column, () => value);
    for (const column of Object.keys(derived[0] ?? {})) add(column, (_r, d) => d[column]);

    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const params: unknown[] = [];
      const values = chunk.map((r, j) => {
        const d = derived[i + j];
        return `(${columns.map((c) => (params.push(c.value(r as unknown as Record<string, unknown>, d)), `$${params.length}${castOf(c.type)}`)).join(", ")})`;
      });
      await q(`INSERT INTO ${spec.table} (${columns.map((c) => c.column).join(", ")}) VALUES ${values.join(", ")}`, params);
    }
  }

  return {
    async get(id) {
      const params: unknown[] = [id];
      const extra = fixed.map(([column, value]) => (params.push(value), ` AND ${column} = $${params.length}`)).join("");
      return (await q<R>(`${select} WHERE ${spec.key} = $1${extra}`, params))[0] ?? null;
    },
    async findOne(filter) {
      const params: unknown[] = [];
      return (await q<R>(`${select}${where(filter as Record<string, unknown>, params)} ORDER BY ${spec.order} LIMIT 1`, params))[0] ?? null;
    },
    list,
    async create(row) {
      await insert([row]);
      return structuredClone(row);
    },
    async createMany(rows) {
      await insert(rows);
    },
    async update(id, patch) {
      const params: unknown[] = [];
      const sets: string[] = [];
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined || field === "id") continue;
        const col = colOf.get(field);
        if (!col) throw new Error(`${spec.table}: no column for field ${field}`);
        params.push(toParam(value, col[2]));
        sets.push(`${col[1]} = $${params.length}${castOf(col[2])}`);
      }
      params.push(id);
      const keyParam = `$${params.length}`;
      const extra = fixed.map(([column, value]) => (params.push(value), ` AND ${column} = $${params.length}`)).join("");
      if (sets.length) {
        const changed = await q(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE ${spec.key} = ${keyParam}${extra} RETURNING ${spec.key}`, params);
        if (!changed.length) throw new NotFoundError(`${spec.table} ${id}`);
      }
      const row = await this.get(id);
      if (!row) throw new NotFoundError(`${spec.table} ${id}`);
      return row;
    },
    async delete(id) {
      const params: unknown[] = [id];
      const extra = fixed.map(([column, value]) => (params.push(value), ` AND ${column} = $${params.length}`)).join("");
      const gone = await q(`DELETE FROM ${spec.table} WHERE ${spec.key} = $1${extra} RETURNING ${spec.key}`, params);
      if (!gone.length) throw new NotFoundError(`${spec.table} ${id}`);
    },
  };
}

// ---------------------------------------------------------------- transaction-scoped store

function makeTx(q: Query): StoreTx {
  const repo = <R extends Row>(name: RepoName) => makeRepo<R>(q, SPECS[name] as Spec);
  const ledger = <R extends Row>(name: RepoName): AppendOnlyRepo<R> => {
    const r = repo<R>(name);
    return { list: r.list, append: r.create };
  };
  const lots = repo<DbSnapshot["lots"][number]>("lots");

  const tx: StoreTx = {
    countries: repo("countries"),
    flavours: repo("flavours"),
    partners: repo("partners"),
    users: repo("users"),
    devices: repo("devices"),
    batchCodePool: repo("batchCodePool"),
    batches: repo("batches"),
    printOrders: repo("printOrders"),
    lots: {
      ...lots,
      // Pack rows carry their lot's sync flag too (every code row shows whether it is synced).
      async update(id, patch) {
        const updated = await lots.update(id, patch);
        if (patch.synced !== undefined) await q(`UPDATE codes SET synced = $1 WHERE lot_code = $2 AND code_type = 'PACK'`, [patch.synced, id]);
        return updated;
      },
    },
    packs: repo("packs"),
    movements: ledger("movements"),
    scans: ledger("scans"),
    reprints: ledger("reprints"),
    sessions: repo("sessions"),

    async appendMovement(m: NewMovement) {
      return tx.movements.append({ ...m, id: crypto.randomUUID(), at: m.at ?? new Date().toISOString() });
    },
    async appendScan(s: NewScan) {
      return tx.scans.append({ ...s, id: crypto.randomUUID(), at: s.at ?? new Date().toISOString() });
    },
    async nextLotNumber(batchCode, count) {
      if (!Number.isInteger(count) || count < 1) throw new RangeError(`count must be ≥ 1 (got ${count})`);
      const rows = await q<{ first: number }>(
        `UPDATE batches SET next_lot = next_lot + $2 WHERE batch_code = $1 AND next_lot + $2 - 1 <= $3 RETURNING next_lot - $2 AS first`,
        [batchCode, count, LOT_NUMBER_MAX],
      );
      if (rows.length) return Number(rows[0].first);
      if (!(await q(`SELECT 1 FROM batches WHERE batch_code = $1`, [batchCode])).length) throw new NotFoundError(`Batch ${batchCode}`);
      throw new RangeError(`Batch ${batchCode} has no room for ${count} more lots (max 1869F)`);
    },
    async nextSequence(name) {
      const rows = await q<{ last_value: number }>(
        `INSERT INTO id_counters (name, last_value) VALUES ($1, 1)
         ON CONFLICT (name) DO UPDATE SET last_value = id_counters.last_value + 1 RETURNING last_value`,
        [name],
      );
      return Number(rows[0].last_value);
    },
    async getSettings() {
      const rows = await q<{ data: Partial<Settings> }>(`SELECT data FROM settings WHERE id = $1`, [SETTINGS_ID]);
      return { ...DEFAULT_SETTINGS, ...rows[0]?.data, id: SETTINGS_ID } as Settings;
    },
    async updateSettings(patch) {
      const next = { ...(await tx.getSettings()), ...structuredClone(patch), id: SETTINGS_ID };
      await q(`INSERT INTO settings (id, data) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [SETTINGS_ID, JSON.stringify(next)]);
      return next;
    },
  };
  return tx;
}

// ---------------------------------------------------------------- store

/** The schema version recorded in the database (0 = no schema yet). */
async function schemaVersion(d: SqlDriver): Promise<number> {
  try {
    const rows = await d.query<{ version: number }>(`SELECT version FROM schema_info WHERE id = 1`);
    return Number(rows[0]?.version ?? 0);
  } catch {
    return 0; // no schema_info table yet
  }
}

const COLLECTION_REPOS = ["countries", "flavours", "partners", "users", "sessions", "devices", "batchCodePool", "batches", "printOrders", "lots", "packs"] as const;
const LEDGERS = ["movements", "scans", "reprints"] as const;

export class SqlStore implements Store {
  private conn: Promise<SqlDriver> | null = null;
  private ready: Promise<SqlDriver> | null = null;

  /**
   * @param connect opens the connection (once, on first use).
   * @param firstRun data for an empty database (no sign-ins yet); null leaves it empty.
   */
  constructor(
    private readonly connect: () => Promise<SqlDriver>,
    private readonly firstRun: ((label: string) => DbSnapshot) | null = null,
  ) {}

  /** The connection as it is, schema not checked (shared by everything below). */
  private connection(): Promise<SqlDriver> {
    this.conn ??= this.connect().catch((e) => {
      this.conn = null;
      throw e;
    });
    return this.conn;
  }

  /** Connect, apply the schema if the database doesn't have this version yet, and set up a first start if it is empty. */
  driver(): Promise<SqlDriver> {
    this.ready ??= (async () => {
      const d = await this.connection();
      if ((await schemaVersion(d)) !== SCHEMA_VERSION) await d.exec(SCHEMA_SQL);
      if (this.firstRun && !(await d.query(`SELECT 1 FROM users LIMIT 1`)).length) await this.load(d, this.firstRun(d.label));
      return d;
    })().catch((e) => {
      this.ready = null; // try again on the next request (e.g. the database was still starting)
      throw e;
    });
    return this.ready;
  }

  /** Where the data lives, for log lines. */
  async label(): Promise<string> {
    return (await this.driver()).label;
  }

  /** Apply the schema even if the database reports this version (`npm run db:migrate`). */
  async migrate(): Promise<SqlDriver> {
    const d = await this.driver();
    await d.exec(SCHEMA_SQL);
    return d;
  }

  async transaction<R>(fn: (tx: StoreTx) => Promise<R>): Promise<R> {
    const d = await this.driver();
    return d.transaction((q) => fn(makeTx(q)));
  }

  /** Replace all data. `version` = the database's schema version: an older one is upgraded in the same transaction. */
  private async load(d: SqlDriver, data: DbSnapshot, version = SCHEMA_VERSION) {
    await d.transaction(async (q, exec) => {
      if (!version) await exec(SCHEMA_SQL); // no tables yet
      await q(`TRUNCATE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
      // An older schema is upgraded once its rows are gone, so values it no longer allows (a v1
      // database's Suppliers and Outlets) don't stop the upgrade; the new data is then checked by it.
      if (version && version !== SCHEMA_VERSION) await exec(SCHEMA_SQL);
      const tx = makeTx(q);
      for (const name of COLLECTION_REPOS) await (tx[name] as Repo<Row>).createMany((data[name] ?? []) as Row[]);
      for (const name of LEDGERS) for (const row of data[name] ?? []) await (tx[name] as AppendOnlyRepo<Row>).append(row);
      for (const s of data.sequences ?? []) await q(`INSERT INTO id_counters (name, last_value) VALUES ($1, $2)`, [s.id, s.value]);
      for (const s of data.settings ?? []) await q(`INSERT INTO settings (id, data) VALUES ($1, $2::jsonb)`, [s.id, JSON.stringify(s)]);
    });
  }

  /** Works on a database with an older schema too (seed, import, chain conversion): it is upgraded with the new data. */
  async reset(data: DbSnapshot): Promise<void> {
    const d = await this.connection();
    await this.load(d, data, await schemaVersion(d));
  }

  async snapshot(): Promise<DbSnapshot> {
    // A database with an older schema is read as it is (the chain conversion reads a v1 database,
    // which the v2 schema refuses to upgrade until its data is converted).
    const raw = await this.connection();
    const version = await schemaVersion(raw);
    const d = version && version !== SCHEMA_VERSION ? raw : await this.driver();
    return d.transaction(async (q) => {
      const tx = makeTx(q);
      const out: Record<string, unknown> = {};
      for (const name of [...COLLECTION_REPOS, ...LEDGERS]) out[name] = await tx[name].list();
      const counters = await q<{ name: string; last_value: number }>(`SELECT name, last_value FROM id_counters ORDER BY name`);
      out.sequences = counters.map((r) => ({ id: r.name, value: Number(r.last_value) }));
      out.settings = [await tx.getSettings()];
      return out as unknown as DbSnapshot;
    });
  }

  async close() {
    const conn = this.conn;
    this.conn = null;
    this.ready = null;
    if (conn) await (await conn).close();
  }

  // Top-level repos: reads go straight to the database; writes run as one-step transactions.
  private repo<R extends Row>(name: RepoName): Repo<R> {
    const read = async () => makeTx((await this.driver()).query)[name] as unknown as Repo<R>;
    const write =
      <A extends unknown[], X>(op: (r: Repo<R>, ...a: A) => Promise<X>) =>
      (...a: A) =>
        this.transaction((tx) => op(tx[name] as unknown as Repo<R>, ...a));
    return {
      get: async (id) => (await read()).get(id),
      findOne: async (where) => (await read()).findOne(where),
      list: async (where) => (await read()).list(where),
      create: write((r, row: R) => r.create(row)),
      createMany: write((r, rows: R[]) => r.createMany(rows)),
      update: write((r, id: string, patch: Partial<Omit<R, "id">>) => r.update(id, patch)),
      delete: write((r, id: string) => r.delete(id)),
    };
  }

  private ledger<R extends Row>(name: (typeof LEDGERS)[number]): AppendOnlyRepo<R> {
    const r = this.repo<R>(name);
    return { list: r.list, append: (row) => this.transaction((tx) => (tx[name] as unknown as AppendOnlyRepo<R>).append(row)) };
  }

  countries = this.repo<DbSnapshot["countries"][number]>("countries");
  flavours = this.repo<DbSnapshot["flavours"][number]>("flavours");
  partners = this.repo<DbSnapshot["partners"][number]>("partners");
  users = this.repo<DbSnapshot["users"][number]>("users");
  devices = this.repo<DbSnapshot["devices"][number]>("devices");
  batchCodePool = this.repo<DbSnapshot["batchCodePool"][number]>("batchCodePool");
  batches = this.repo<DbSnapshot["batches"][number]>("batches");
  printOrders = this.repo<DbSnapshot["printOrders"][number]>("printOrders");
  lots = this.repo<DbSnapshot["lots"][number]>("lots");
  packs = this.repo<DbSnapshot["packs"][number]>("packs");
  movements = this.ledger<DbSnapshot["movements"][number]>("movements");
  scans = this.ledger<DbSnapshot["scans"][number]>("scans");
  reprints = this.ledger<DbSnapshot["reprints"][number]>("reprints");
  sessions = this.repo<DbSnapshot["sessions"][number]>("sessions");

  appendMovement(m: NewMovement) {
    return this.transaction((tx) => tx.appendMovement(m));
  }
  appendScan(s: NewScan) {
    return this.transaction((tx) => tx.appendScan(s));
  }
  nextLotNumber(batchCode: string, count: number) {
    return this.transaction((tx) => tx.nextLotNumber(batchCode, count));
  }
  nextSequence(name: string) {
    return this.transaction((tx) => tx.nextSequence(name));
  }
  async getSettings() {
    return makeTx((await this.driver()).query).getSettings();
  }
  updateSettings(patch: Partial<Omit<Settings, "id">>) {
    return this.transaction((tx) => tx.updateSettings(patch));
  }
}
