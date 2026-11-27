// Store implementation over PostgreSQL. Each repo maps an app collection onto the schema
// (schema.ts): lots and packs are rows of the one `codes` table, movements, scans and reprints are
// rows of `code_history`. Field names stay the app's; column names are the database's.

import { createHash } from "node:crypto";
import { after } from "next/server";
import { LOT_NUMBER_MAX } from "@/lib/core/codes";
import { DEFAULT_SETTINGS, type Container, type ContainerStatus, type DamageReport, type ItemStatus, type LotType, type Movement, type Pack, type Scan, type Settings } from "@/lib/core/types";
import { assertOwnStateValues, damageReportsFor, infersFollow, isPackStateField, LOT_OPENED_MESSAGE, PACK_STATE_FIELDS, type PackState } from "../packState";
import { IntegrityError, NotFoundError, type AppendOnlyRepo, type DbSnapshot, type LedgerReadOptions, type NewMovement, type NewScan, type Repo, type Row, type StockSummaryRow, type Store, type StoreTx, type TransactionOptions, type Where } from "../Store";
import type { Query, SqlDriver } from "./driver";
import { ALL_TABLES, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

type ColType = "text" | "int" | "bool" | "ts" | "date" | "json" | "textarr" | "uuid";
type Col = [field: string, column: string, type?: ColType];

interface Spec {
  table: string;
  /** Primary key column (the app's `id`). */
  key: string;
  cols: Col[];
  /** Column values that pick this collection's rows out of a shared table (codes, code_history). */
  fixed?: Record<string, string>;
  /**
   * Extra columns written on insert, derived from the row (and the database). A derived value for a column the row
   * maps itself replaces the row's value (a following pack's state columns: NULL).
   */
  derive?: (rows: Record<string, unknown>[], q: Query) => Promise<Record<string, unknown>[]>;
  order: string;
  /** Ledgers: the time column a read's `since` bounds (code_history is partitioned by it). */
  timeColumn?: string;
}

const SETTINGS_ID = "default";
const INSERT_CHUNK = 1000;
/** Bind parameters per statement, under PostgreSQL's limit of 65,535. */
const MAX_PARAMS = 60_000;

const CASTS: Partial<Record<ColType, string>> = { ts: "::timestamptz", date: "::date", json: "::jsonb", textarr: "::text[]", int: "::integer", bool: "::boolean", uuid: "::uuid" };
const castOf = (t: ColType | undefined) => (t ? (CASTS[t] ?? "") : "");

/**
 * History event ids are uuid (schema v11). A value that can't be one matches nothing (as on the JSON store) instead of
 * reaching PostgreSQL, which would refuse it with an error: a mistyped id in a URL is "not found", not a failure.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fitsColumn = (v: unknown, type: ColType | undefined) => type !== "uuid" || (typeof v === "string" && UUID.test(v));

/** A history id as stored from v11: a UUID as it is, anything else as the md5 of it written as a UUID (= md5(id)::uuid). */
export function asHistoryId(id: string): string {
  if (UUID.test(id)) return id;
  const h = createHash("md5").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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
      ["approval", "approval"],
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
      ["kind", "order_kind"],
      ["requestFingerprint", "request_fingerprint"],
    ),
  },
  containers: {
    table: "containers",
    key: "container_id",
    order: "row_no",
    cols: T(
      ["id", "container_id"],
      ["code", "container_code"],
      ["manufacturerId", "manufacturer_id"],
      ["status", "status"],
      ["lotCodes", "lot_codes", "textarr"],
      ["toId", "to_partner_id"],
      ["invoice", "invoice"],
      ["createdAt", "created_at", "ts"],
      ["createdBy", "created_by"],
      ["dispatchedAt", "dispatched_at", "ts"],
      ["dispatchedBy", "dispatched_by"],
      ["receivedAt", "received_at", "ts"],
      ["receivedBy", "received_by"],
      ["clearedAt", "cleared_at", "ts"],
      ["clearedBy", "cleared_by"],
      ["billOfEntry", "bill_of_entry"],
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
      // A pack carries its lot's sync flag (lots.update keeps them equal afterwards). Taken from the lot, not the batch:
      // a continuation order made offline adds unsynced lots to a batch that is already synced. The lot's state decides
      // whether a pack written without followsLot follows it (Option C, the v11 upgrade's rule).
      const lotCodes = [...new Set(rows.map((r) => String(r.lotCode)))];
      const lotRows = await q<PackState & { code: string; synced: boolean }>(
        `SELECT code, synced, status AS "status", location_id AS "locationId", in_transit_to AS "inTransitToId",
                ${selectExpr(["dispatchedAt", "dispatched_at", "ts"])}, status_before_recall AS "statusBeforeRecall"
           FROM codes WHERE code = ANY($1::text[]) AND code_type = 'LOT'`,
        [lotCodes],
      );
      const lotByCode = new Map(lotRows.map((l) => [l.code, l]));
      return rows.map((r) => {
        const code = String(r.packCode ?? r.id);
        const p = parts(code);
        const b = info.get(p.batch_code);
        const lot = lotByCode.get(String(r.lotCode));
        const follows = (r.followsLot as boolean | undefined) ?? (r.status === null || infersFollow(r as unknown as PackState, lot));
        if (!follows) assertOwnStateValues(r); // the same refusal as the JSON store, before the database's check
        return {
          ...p,
          // A following pack stores no state of its own (all five columns NULL: "same as my lot").
          ...(follows ? Object.fromEntries(PACK_STATE_COLUMNS.map((c) => [c, null])) : {}),
          lot_type: Number(r.packSize) === 6 ? "CASE" : "TRAY",
          mfg_date: b?.mfg_date ?? null,
          expiry_date: b?.expiry_date ?? null,
          manufacturer_id: b?.manufacturer_id ?? null,
          device_id: b?.device_id ?? null,
          print_order_id: b?.print_order_id ?? null,
          synced: lot?.synced ?? b?.synced ?? true,
          generated_by: b?.created_by ?? null,
        };
      });
    },
  },
  movements: {
    table: "code_history",
    key: "event_id",
    order: "history_id",
    timeColumn: "event_time",
    fixed: { record_type: "MOVEMENT" },
    cols: T(
      ["id", "event_id", "uuid"],
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
    timeColumn: "event_time",
    fixed: { record_type: "SCAN" },
    cols: T(
      ["id", "event_id", "uuid"],
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
    cols: T(["id", "event_id", "uuid"], ["at", "event_time", "ts"], ["code", "code"], ["itemKind", "item_kind"], ["reason", "reason"], ["userId", "login_id"], ["deviceId", "device_id"], ["printOrderId", "print_order_id"]),
    derive: async (rows) => rows.map(() => ({ event: "REPRINTED", ok: true, result: "OK" })),
    timeColumn: "event_time",
  },
  damageReports: {
    table: "damage_reports",
    key: "report_id",
    order: "reported_at",
    timeColumn: "reported_at",
    cols: T(
      ["id", "report_id", "uuid"],
      ["code", "code"],
      ["itemKind", "item_kind"],
      ["partnerId", "partner_id"],
      ["reason", "reason"],
      ["packsAffected", "packs_affected", "int"],
      ["reportedBy", "reported_by"],
      ["reportedAt", "reported_at", "ts"],
    ),
  },
} satisfies Record<string, Spec>;

type RepoName = keyof typeof SPECS;

/** `SELECT <every column AS its field> FROM <table>` of a collection, for the few hand-written queries below. */
const selectOf = (spec: Spec) => `SELECT ${spec.cols.map(selectExpr).join(", ")} FROM ${spec.table}`;

// ---------------------------------------------------------------- generic repo

/**
 * One filter condition on an SQL expression (a column, or an effective pack state): null → IS NULL; an array → "any of"
 * (= ANY, so an index on the column is used; null in the list matches NULL, as in the JSON store); a value → equality.
 */
function condition(table: string, field: string, expr: string, type: ColType | undefined, value: unknown, params: unknown[]): string {
  if (value === null) return `${expr} IS NULL`;
  if (Array.isArray(value)) {
    if (type === "json" || type === "textarr") throw new Error(`${table}: field ${field} takes equality only`);
    // A value that can't be in the column (a non-UUID history id) is left out: it matches nothing.
    const values = value.filter((v) => v !== null && fitsColumn(v, type));
    params.push(values.map((v) => toParam(v, type)));
    const any = `${expr} = ANY($${params.length}${castOf(type) || "::text"}[])`;
    return value.includes(null) ? `(${any} OR ${expr} IS NULL)` : any;
  }
  if (!fitsColumn(value, type)) return "false";
  params.push(toParam(value, type));
  return `${expr} = $${params.length}${castOf(type)}`;
}

/** A repo with ledger reads: `list(where, { since })` (only tables with a time column take `since`). */
type SqlRepo<R extends Row> = Repo<R> & { list(where?: Where<R>, opts?: LedgerReadOptions): Promise<R[]> };

function makeRepo<R extends Row>(q: Query, spec: Spec): SqlRepo<R> {
  const colOf = new Map(spec.cols.map((c) => [c[0], c]));
  const select = `SELECT ${spec.cols.map(selectExpr).join(", ")} FROM ${spec.table}`;
  const fixed = Object.entries(spec.fixed ?? {});
  /** Type of the primary key column: an id that can't be one is simply not found. */
  const keyType = spec.cols.find(([, column]) => column === spec.key)?.[2];

  function where(filter: Record<string, unknown> | undefined, params: unknown[], opts?: LedgerReadOptions): string {
    const parts = fixed.map(([column, value]) => (params.push(value), `${column} = $${params.length}`));
    for (const [field, value] of Object.entries(filter ?? {})) {
      if (value === undefined) continue;
      const col = colOf.get(field);
      if (!col) throw new Error(`${spec.table}: no column for field ${field}`);
      parts.push(condition(spec.table, field, col[1], col[2], value, params));
    }
    if (opts?.since) {
      if (!spec.timeColumn) throw new Error(`${spec.table}: no time column for since`);
      // A bound on the partition key: only the history months from then on are read (partition pruning).
      params.push(opts.since);
      parts.push(`${spec.timeColumn} >= $${params.length}::timestamptz`);
    }
    return parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
  }

  const list = async (filter?: Where<R>, opts?: LedgerReadOptions) => {
    const params: unknown[] = [];
    return q<R>(`${select}${where(filter as Record<string, unknown>, params, opts)} ORDER BY ${spec.order}`, params);
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
      columns.push({ column, type, value: (r, d) => (Object.hasOwn(d, column) ? d[column] : toParam(r[field], type)) });
    }
    const add = (column: string, value: (r: Record<string, unknown>, d: Record<string, unknown>) => unknown) => {
      if (seen.has(column)) return;
      seen.add(column);
      columns.push({ column, value });
    };
    for (const [column, value] of fixed) add(column, () => value);
    for (const column of Object.keys(derived[0] ?? {})) add(column, (_r, d) => d[column]);

    // As many rows per statement as PostgreSQL's bind-parameter limit allows (65,535), at most INSERT_CHUNK.
    const per = Math.max(1, Math.min(INSERT_CHUNK, Math.floor(MAX_PARAMS / columns.length)));
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      const params: unknown[] = [];
      const values = chunk.map((r, j) => {
        const d = derived[i + j];
        return `(${columns.map((c) => (params.push(c.value(r as unknown as Record<string, unknown>, d)), `$${params.length}${castOf(c.type)}`)).join(", ")})`;
      });
      await q(`INSERT INTO ${spec.table} (${columns.map((c) => c.column).join(", ")}) VALUES ${values.join(", ")}`, params);
    }
  }

  /** `SET a = $1, b = $2 …` for a patch (id and undefined fields skipped); the values are pushed onto `params`. */
  function setClause(patch: Record<string, unknown>, params: unknown[]): string[] {
    const sets: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      if (value === undefined || field === "id") continue;
      const col = colOf.get(field);
      if (!col) throw new Error(`${spec.table}: no column for field ${field}`);
      params.push(toParam(value, col[2]));
      sets.push(`${col[1]} = $${params.length}${castOf(col[2])}`);
    }
    return sets;
  }

  return {
    async updateWhere(filter, patch) {
      if (!Object.values(filter ?? {}).some((v) => v !== undefined)) throw new Error(`${spec.table}: updateWhere needs a filter`);
      const params: unknown[] = [];
      const sets = setClause(patch as Record<string, unknown>, params);
      if (!sets.length) return (await list(filter)).map((r) => r.id);
      const rows = await q<{ id: string; ord: string | number }>(
        `UPDATE ${spec.table} SET ${sets.join(", ")}${where(filter as Record<string, unknown>, params)} RETURNING ${spec.key} AS id, ${spec.order} AS ord`,
        params,
      );
      return rows.sort((a, b) => Number(a.ord) - Number(b.ord)).map((r) => r.id);
    },
    async get(id) {
      if (!fitsColumn(id, keyType)) return null;
      const params: unknown[] = [id];
      const extra = fixed.map(([column, value]) => (params.push(value), ` AND ${column} = $${params.length}`)).join("");
      return (await q<R>(`${select} WHERE ${spec.key} = $1${extra}`, params))[0] ?? null;
    },
    async findOne(filter) {
      const params: unknown[] = [];
      return (await q<R>(`${select}${where(filter as Record<string, unknown>, params)} ORDER BY ${spec.order} LIMIT 1`, params))[0] ?? null;
    },
    list,
    async exists(filter) {
      const params: unknown[] = [];
      const rows = await q<{ e: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${spec.table}${where(filter as Record<string, unknown>, params)}) AS e`, params);
      return !!rows[0]?.e;
    },
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
      if (!fitsColumn(id, keyType)) throw new NotFoundError(`${spec.table} ${id}`);
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
      if (!fitsColumn(id, keyType)) throw new NotFoundError(`${spec.table} ${id}`);
      const params: unknown[] = [id];
      const extra = fixed.map(([column, value]) => (params.push(value), ` AND ${column} = $${params.length}`)).join("");
      const gone = await q(`DELETE FROM ${spec.table} WHERE ${spec.key} = $1${extra} RETURNING ${spec.key}`, params);
      if (!gone.length) throw new NotFoundError(`${spec.table} ${id}`);
    },
  };
}

// ---------------------------------------------------------------- packs (Option C, schema v11)

/** The state columns of a pack: all NULL while it follows its sealed lot, all its own once it has a state of its own. */
const PACK_STATE_COLUMNS = PACK_STATE_FIELDS.map((f) => PACK_COLS.find(([field]) => field === f)![1]);
const PACK_STATE_COLUMN_SET = new Set(PACK_STATE_COLUMNS);
/** Each column of PACK_COLS once (id and packCode are both `code`). */
const PACK_COLUMNS = [...new Set(PACK_COLS.map(([, column]) => column))];
/** A pack's effective value of a column: its lot's while it follows it (status NULL), its own otherwise. */
const effective = (column: string) => (PACK_STATE_COLUMN_SET.has(column) ? `CASE WHEN p.status IS NULL THEN l.${column} ELSE p.${column} END` : `p.${column}`);

/**
 * The packs repo. Every read gives the effective state (the lot's for a following pack, as view code_state does) and
 * `followsLot`. A filter on a state field is a UNION ALL of two index-backed parts instead of a filter on the effective
 * value (which no index serves): packs with a state of their own (by their own columns: codes_location,
 * codes_in_transit_to …) and following packs found through their lot (the lot by the same indexes, then its packs by
 * codes_lot). Writes follow packState.ts: a state field written to a following pack gives it a state of its own (the
 * columns the patch leaves out copied from its lot in the same statement), followsLot: true clears its state.
 */
function makePackRepo(q: Query): Repo<Pack> {
  const spec = SPECS.packs as Spec;
  const base = makeRepo<Pack>(q, spec);
  const colOf = new Map(PACK_COLS.map((c) => [c[0], c]));
  const outer = `${PACK_COLS.map(selectExpr).join(", ")}, x.follows AS "followsLot"`;

  type Branch = "own" | "follow" | "mixed";
  const FROM: Record<Branch, string> = {
    own: `FROM codes p WHERE p.code_type = 'PACK' AND p.status IS NOT NULL`,
    follow: `FROM codes l JOIN codes p ON p.lot_code = l.code AND p.code_type = 'PACK' AND p.status IS NULL WHERE l.code_type = 'LOT'`,
    mixed: `FROM codes p LEFT JOIN codes l ON l.code = p.lot_code AND l.code_type = 'LOT' WHERE p.code_type = 'PACK'`,
  };
  const valueOf = (branch: Branch, column: string) =>
    !PACK_STATE_COLUMN_SET.has(column) ? `p.${column}` : branch === "own" ? `p.${column}` : branch === "follow" ? `l.${column}` : effective(column);
  const FOLLOWS: Record<Branch, string> = { own: "false", follow: "true", mixed: "(p.status IS NULL)" };

  /** The inner SELECT of one branch with its filter conditions (state fields on the branch's own source). */
  function branchSql(branch: Branch, filter: Record<string, unknown>, params: unknown[]): string {
    const cols = PACK_COLUMNS.map((c) => `${valueOf(branch, c)} AS ${c}`).join(", ");
    const conds: string[] = [];
    for (const [field, value] of Object.entries(filter)) {
      if (value === undefined || field === "followsLot") continue;
      const col = colOf.get(field);
      if (!col) throw new Error(`packs: no column for field ${field}`);
      conds.push(condition("packs", field, valueOf(branch, col[1]), col[2], value, params));
    }
    return `SELECT ${cols}, ${FOLLOWS[branch]} AS follows, p.row_no ${FROM[branch]}${conds.map((c) => ` AND ${c}`).join("")}`;
  }

  /** The inner query for a filter: one join when no state field is filtered, else own UNION ALL following (null: none). */
  function inner(where: Where<Pack> | undefined, params: unknown[]): string | null {
    const filter = Object.fromEntries(Object.entries(where ?? {}).filter(([, v]) => v !== undefined));
    const follows = filter.followsLot as boolean | readonly boolean[] | null | undefined;
    const allowed = (b: boolean) => follows === undefined || (Array.isArray(follows) ? follows.includes(b) : follows === b);
    const byState = Object.keys(filter).some(isPackStateField);
    const branches: Branch[] = !byState && follows === undefined ? ["mixed"] : ([allowed(false) && "own", allowed(true) && "follow"].filter(Boolean) as Branch[]);
    if (!branches.length) return null; // followsLot: [] matches nothing
    return branches.map((b) => branchSql(b, filter, params)).join(" UNION ALL ");
  }

  const read = async (where: Where<Pack> | undefined, tail = ""): Promise<Pack[]> => {
    const params: unknown[] = [];
    const sql = inner(where, params);
    return sql === null ? [] : q<Pack>(`SELECT ${outer} FROM (${sql}) x ORDER BY x.row_no${tail}`, params);
  };

  /** SET list and FROM for a patch: see packState.ts packPatchToStore (the same rules, in one statement). */
  function setClause(patch: Partial<Omit<Pack, "id">>, params: unknown[]): string[] {
    const { followsLot, ...rest } = patch;
    const sets: string[] = [];
    const given = new Set<string>();
    for (const [field, value] of Object.entries(rest)) {
      if (value === undefined || field === "id") continue;
      const col = colOf.get(field);
      if (!col) throw new Error(`packs: no column for field ${field}`);
      if (PACK_STATE_COLUMN_SET.has(col[1])) given.add(col[1]);
      params.push(toParam(value, col[2]));
      sets.push(`${col[1]} = $${params.length}${castOf(col[2])}`);
    }
    assertOwnStateValues(rest);
    if (followsLot === true) {
      if (given.size) throw new Error("packs: a pack that follows its lot takes no state of its own");
      return [...sets, ...PACK_STATE_COLUMNS.map((c) => `${c} = NULL`)];
    }
    if (!given.size && followsLot !== false) return sets;
    // A state of its own: the columns not in the patch keep the pack's own value, or take its lot's if it follows.
    for (const c of PACK_STATE_COLUMNS) if (!given.has(c)) sets.push(`${c} = ${effective(c)}`);
    return sets;
  }

  async function update(filterSql: (params: unknown[]) => string, patch: Partial<Omit<Pack, "id">>): Promise<string[]> {
    const params: unknown[] = [];
    const sets = setClause(patch, params);
    const filter = filterSql(params);
    if (!sets.length) {
      const rows = await q<{ id: string }>(`SELECT p.code AS id FROM codes p LEFT JOIN codes l ON l.code = p.lot_code AND l.code_type = 'LOT' WHERE p.code_type = 'PACK' AND ${filter} ORDER BY p.row_no`, params);
      return rows.map((r) => r.id);
    }
    // Joined to its lot, whose state the patch may copy and the filter may read; a pack's lot always exists (foreign key).
    const rows = await q<{ id: string; ord: string | number }>(
      `UPDATE codes p SET ${sets.join(", ")}
         FROM codes l
        WHERE l.code = p.lot_code AND l.code_type = 'LOT' AND p.code_type = 'PACK' AND ${filter}
       RETURNING p.code AS id, p.row_no AS ord`,
      params,
    );
    return rows.sort((a, b) => Number(a.ord) - Number(b.ord)).map((r) => r.id);
  }

  /** The filter of updateWhere on the joined row (p, l): effective state, as reads see it. */
  const joinedFilter = (where: Where<Pack>) => (params: unknown[]) => {
    const conds: string[] = [];
    for (const [field, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (field === "followsLot") {
        // As reads (inner) and the JSON store: null and [] match nothing, [true, false] anything.
        const wanted = value === null ? [] : Array.isArray(value) ? value : [value];
        const follow = wanted.includes(true);
        const own = wanted.includes(false);
        if (!follow && !own) conds.push("false");
        else if (follow !== own) conds.push(follow ? "p.status IS NULL" : "p.status IS NOT NULL");
        continue;
      }
      const col = colOf.get(field);
      if (!col) throw new Error(`packs: no column for field ${field}`);
      conds.push(condition("packs", field, effective(col[1]), col[2], value, params));
    }
    return conds.length ? conds.join(" AND ") : "true";
  };

  const repo: Repo<Pack> = {
    async get(id) {
      return (await read({ id }))[0] ?? null;
    },
    async findOne(where) {
      return (await read(where, " LIMIT 1"))[0] ?? null;
    },
    list: (where) => read(where),
    async exists(where) {
      const params: unknown[] = [];
      const sql = inner(where, params);
      return sql !== null && (await q(`SELECT 1 FROM (${sql}) x LIMIT 1`, params)).length > 0;
    },
    create: base.create,
    createMany: base.createMany,
    async update(id, patch) {
      const changed = await update((params) => (params.push(id), `p.code = $${params.length}`), patch);
      if (!changed.length) throw new NotFoundError(`codes ${id}`);
      const row = await repo.get(id);
      if (!row) throw new NotFoundError(`codes ${id}`);
      return row;
    },
    async updateWhere(where, patch) {
      if (!Object.values(where ?? {}).some((v) => v !== undefined)) throw new Error("codes: updateWhere needs a filter");
      return update(joinedFilter(where), patch);
    },
    delete: base.delete,
  };
  return repo;
}

// ---------------------------------------------------------------- transaction-scoped store

function makeTx(q: Query): StoreTx {
  const repo = <R extends Row>(name: RepoName) => makeRepo<R>(q, SPECS[name] as Spec);
  const ledger = <R extends Row>(name: RepoName): AppendOnlyRepo<R> => {
    const r = repo<R>(name);
    return { list: r.list, exists: r.exists, append: r.create };
  };
  const lots = repo<DbSnapshot["lots"][number]>("lots");
  const movementRows = repo<Movement>("movements");

  const tx: StoreTx = {
    countries: repo("countries"),
    flavours: repo("flavours"),
    partners: repo("partners"),
    users: repo("users"),
    devices: repo("devices"),
    batchCodePool: repo("batchCodePool"),
    batches: repo("batches"),
    printOrders: repo("printOrders"),
    // The Container type keeps its lotCodes array; triggers on containers (schema v10) keep container_items equal to it.
    containers: repo<Container>("containers"),
    lots: {
      ...lots,
      // Pack rows carry their lot's sync flag too (every code row shows whether it is synced).
      async update(id, patch) {
        const updated = await lots.update(id, patch);
        if (patch.synced !== undefined) await q(`UPDATE codes SET synced = $1 WHERE lot_code = $2 AND code_type = 'PACK'`, [patch.synced, id]);
        return updated;
      },
      async updateWhere(where, patch) {
        const ids = await lots.updateWhere(where, patch);
        if (patch.synced !== undefined && ids.length) await q(`UPDATE codes SET synced = $1 WHERE lot_code = ANY($2::text[]) AND code_type = 'PACK'`, [patch.synced, ids]);
        return ids;
      },
    },
    packs: makePackRepo(q),
    movements: ledger("movements"),
    scans: ledger("scans"),
    reprints: ledger("reprints"),
    damageReports: ledger<DamageReport>("damageReports"),
    sessions: repo("sessions"),

    async appendMovement(m: NewMovement) {
      return tx.movements.append({ ...m, id: crypto.randomUUID(), at: m.at ?? new Date().toISOString() });
    },
    async appendMovements(ms: NewMovement[]) {
      const now = new Date().toISOString();
      const rows: Movement[] = ms.map((m) => ({ ...m, id: crypto.randomUUID(), at: m.at ?? now }));
      await movementRows.createMany(rows);
      return rows;
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

    async recentScans(limit) {
      // Index code_history_scans_recent (v9): reads `limit` rows, never the whole ledger.
      return q<Scan>(`${selectOf(SPECS.scans)} WHERE record_type = 'SCAN' ORDER BY event_time DESC, history_id ASC LIMIT $1`, [Math.max(0, Math.floor(limit))]);
    },
    async latestContainerWithLot(toId, lotCode, statuses) {
      // container_items (v10), by its index on lot_code: the few containers that ever carried this lot.
      const rows = await q<Container>(
        `${selectOf(SPECS.containers)}
          WHERE container_id IN (SELECT container_id FROM container_items WHERE lot_code = $1)
            AND to_partner_id = $2 AND status = ANY($3::text[])
          ORDER BY dispatched_at DESC NULLS LAST, row_no ASC LIMIT 1`,
        [lotCode, toId, [...statuses]],
      );
      return rows[0] ?? null;
    },
    async stockSummary() {
      // stock_current (v9) = rolled-up stock_summary + recent stock_deltas: a few hundred rows whatever the code count.
      const rows = await q<{ location_id: string; status: string; code_type: string; lot_type: string; flavour: string; synced: boolean; units: string | number }>(
        `SELECT location_id, status, code_type, lot_type, flavour, synced, units FROM stock_current`,
      );
      return rows.map(
        (r): StockSummaryRow => ({
          locationId: r.location_id,
          status: r.status as ItemStatus,
          kind: r.code_type as StockSummaryRow["kind"],
          lotType: r.lot_type as LotType,
          flavour: r.flavour,
          synced: r.synced,
          units: Number(r.units),
        }),
      );
    },
    async historyAtPartner(partnerId) {
      // code_history_location (v11): one index probe per partition, stopping at the first row.
      const rows = await q<{ e: boolean }>(`SELECT EXISTS (SELECT 1 FROM code_history WHERE location_id = $1) AS e`, [partnerId]);
      return !!rows[0]?.e;
    },
  };
  return tx;
}

// ---------------------------------------------------------------- store

let warnedNewerSchema = false;
/** Running older code on a newer database (a rollback): fine by design, but say so once in the log. */
function warnNewerSchema(version: number) {
  if (warnedNewerSchema) return;
  warnedNewerSchema = true;
  console.warn(`[velza] The database schema is v${version}, newer than this release's v${SCHEMA_VERSION} (a rollback?). Leaving it unchanged.`);
}

/** The schema version recorded in the database (0 = no schema yet). */
async function schemaVersion(d: SqlDriver): Promise<number> {
  try {
    const rows = await d.query<{ version: number }>(`SELECT version FROM schema_info WHERE id = 1`);
    return Number(rows[0]?.version ?? 0);
  } catch {
    return 0; // no schema_info table yet
  }
}

const COLLECTION_REPOS = ["countries", "flavours", "partners", "users", "sessions", "devices", "batchCodePool", "batches", "printOrders", "containers", "lots", "packs"] as const;
const LEDGERS = ["movements", "scans", "reprints", "damageReports"] as const;

/** How often (at most) one process folds stock_deltas into stock_summary by itself. */
export const STOCK_ROLLUP_INTERVAL_MS = 60_000;
/** How often (at most) one process makes sure the next months of history have their partitions (schema v11). */
export const PARTITION_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface SqlStoreOptions {
  /** Least time between two in-app stock rollups of this store (default STOCK_ROLLUP_INTERVAL_MS; Infinity = never). */
  stockRollupIntervalMs?: number;
}

export class SqlStore implements Store {
  private conn: Promise<SqlDriver> | null = null;
  private ready: Promise<SqlDriver> | null = null;
  private lastStockRollup = Number.NEGATIVE_INFINITY;
  private lastPartitionCheck = Number.NEGATIVE_INFINITY;
  private stockRollupRun: Promise<void> = Promise.resolve();
  private readonly stockRollupIntervalMs: number;

  /**
   * @param connect opens the connection (once, on first use).
   * @param firstRun data for an empty database (no sign-ins yet); null leaves it empty.
   */
  constructor(
    private readonly connect: () => Promise<SqlDriver>,
    private readonly firstRun: ((label: string) => DbSnapshot) | null = null,
    opts: SqlStoreOptions = {},
  ) {
    this.stockRollupIntervalMs = opts.stockRollupIntervalMs ?? STOCK_ROLLUP_INTERVAL_MS;
  }

  /**
   * Fold stock_deltas into stock_summary now and then, so the deltas table stays small where nothing runs
   * `npm run db:stock -- rollup` on a schedule (Vercel). At most once per interval per process, after a successful
   * transaction or a stock summary read; its own short statement outside every transaction, not awaited by the
   * request. stock_summary_rollup() returns at once if another rollup (another instance, the jobs container) holds
   * its lock. Counts are exact either way, so a failure is only logged.
   *
   * Inside a request the run is handed to Next's after(), so a serverless platform (Vercel) keeps the function alive
   * until it finishes instead of freezing it once the response is sent; the response still doesn't wait for it.
   * Outside a request (scripts, tests, the jobs container) after() throws and the run simply goes on by itself.
   */
  private maybeRollupStock(d: SqlDriver): void {
    const now = Date.now();
    if (now - this.lastStockRollup < this.stockRollupIntervalMs) return;
    this.lastStockRollup = now;
    const run = this.rollupStock(d)
      .then(
        () => undefined,
        (e) => console.error("[velza] Stock summary rollup failed (counts stay exact; it is tried again later):", (e as Error).message),
      )
      .then(() => this.maybeEnsureHistoryMonths(d));
    this.stockRollupRun = run;
    try {
      after(run);
    } catch {
      // Not in a request scope: nothing to keep alive.
    }
  }

  /**
   * Schema v11: history is partitioned by month and a row dated in a month without its partition lands in the default
   * partition. The daily job (velza_daily_maintenance) keeps 3 months ahead; where nothing runs jobs (Vercel, Render,
   * a dev machine) the app does it itself, at most once per PARTITION_CHECK_INTERVAL_MS per process, right after a
   * stock rollup. code_history_ensure_partitions() only looks when the months exist (takes no lock); making one (once a
   * month) briefly locks the empty default partition, so a whole-history read may wait a few seconds, while inserts
   * carry on. A failure is only logged.
   */
  private async maybeEnsureHistoryMonths(d: SqlDriver): Promise<void> {
    const now = Date.now();
    if (now - this.lastPartitionCheck < PARTITION_CHECK_INTERVAL_MS) return;
    this.lastPartitionCheck = now;
    try {
      await d.alone(`SELECT code_history_ensure_partitions()`);
    } catch (e) {
      console.error("[velza] Making the next months of history failed (the daily job or the next check tries again):", (e as Error).message);
    }
  }

  /** Resolves once the last in-app stock rollup started by this store has finished (tests; never rejects). */
  stockRollupIdle(): Promise<void> {
    return this.stockRollupRun;
  }

  /** One rollup run: the delta rows folded in (0 when there were none or another rollup was running). */
  private async rollupStock(d: SqlDriver): Promise<number> {
    const [row] = await d.alone<{ n: string | number }>(`SELECT stock_summary_rollup() AS n`);
    return Number(row?.n ?? 0);
  }

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
      const version = await schemaVersion(d);
      // Only ever move the schema forward. A database that is newer than this code (a rollback to the previous
      // release) is left as it is: schema changes are backward compatible, and re-applying an older schema would
      // set the recorded version back (and, as the app's database role, isn't allowed anyway).
      if (version < SCHEMA_VERSION) await d.exec(SCHEMA_SQL);
      else if (version > SCHEMA_VERSION) warnNewerSchema(version);
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

  /**
   * `npm run db:migrate`: bring the database to this version (driver() does that on connecting). A database already at
   * this version is left alone unless `force` (\`npm run db:migrate -- --force\`): every statement is idempotent, but
   * re-running the schema drops and re-creates triggers on codes and code_history, which waits for every scan in
   * progress and holds the next ones for up to its 10 s lock timeout. Force it only in a quiet moment (repairing a
   * dropped index, say). An older release's schema is never applied to a newer database.
   */
  async migrate(opts: { force?: boolean } = {}): Promise<SqlDriver> {
    const d = await this.driver();
    // Looked at again: the connection may have been checked earlier, before something changed the database.
    const version = await schemaVersion(d);
    if (version < SCHEMA_VERSION || (opts.force && version === SCHEMA_VERSION)) await d.exec(SCHEMA_SQL);
    return d;
  }

  async transaction<R>(fn: (tx: StoreTx) => Promise<R>, opts?: TransactionOptions): Promise<R> {
    const d = await this.driver();
    try {
      const result = await d.transaction((q) => fn(makeTx(q)), opts);
      this.maybeRollupStock(d);
      return result;
    } catch (e) {
      // The integrity triggers (schema v3) raise these; callers see the same error as on the JSON store.
      const code = (e as { code?: string }).code;
      if (code === "VZ001") throw new IntegrityError("COUNTER_BACKWARDS", (e as Error).message);
      if (code === "VZ002") throw new IntegrityError("ISSUED_CODE_PROTECTED", (e as Error).message);
      // v11 Option C: a pack left following a case/tray that is opened (at insert, or at commit).
      if (code === "VZ003") throw new IntegrityError("LOT_OPENED_CONFLICT", LOT_OPENED_MESSAGE(/Lot (\S+)/.exec((e as Error).message)?.[1] ?? "?"));
      throw e;
    }
  }

  /** Replace all data. `version` = the database's schema version: an older one is upgraded in the same transaction. */
  private async load(d: SqlDriver, data: DbSnapshot, version = SCHEMA_VERSION) {
    try {
      await this.loadIn(d, data, version);
    } catch (e) {
      // A foreign key (v10) refusing the data being loaded (a JSON import, a converted database): say which link.
      if ((e as { code?: string }).code === "VZ003") throw new IntegrityError("LOT_OPENED_CONFLICT", LOT_OPENED_MESSAGE(/Lot (\S+)/.exec((e as Error).message)?.[1] ?? "?"));
      if ((e as { code?: string }).code === "23503") {
        const detail = (e as { detail?: string }).detail;
        throw new Error(`The data refers to rows that are not in it: ${(e as Error).message}${detail ? ` (${detail})` : ""}. Nothing was changed.`, { cause: e });
      }
      throw e;
    }
  }

  private async loadIn(d: SqlDriver, data: DbSnapshot, version: number) {
    await d.transaction(async (q, exec) => {
      if (!version) await exec(SCHEMA_SQL); // no tables yet
      // Only the tables this database already has: an older schema gains the newer ones in the upgrade below.
      const present = (await q<{ t: string }>(`SELECT t FROM unnest($1::text[]) WITH ORDINALITY AS a(t, n) WHERE to_regclass(t) IS NOT NULL ORDER BY n`, [[...ALL_TABLES]])).map((r) => r.t);
      await q(`TRUNCATE ${present.join(", ")} RESTART IDENTITY CASCADE`);
      // An older schema is upgraded once its rows are gone, so values it no longer allows (a v1
      // database's Suppliers and Outlets) don't stop the upgrade; the new data is then checked by it.
      if (version && version < SCHEMA_VERSION) await exec(SCHEMA_SQL);
      const tx = makeTx(q);
      for (const name of COLLECTION_REPOS) await (tx[name] as Repo<Row>).createMany((data[name] ?? []) as Row[]);
      // History ids are uuid (v11). Data written before (an old JSON file: "reprint-served:<id>", hand-made test rows)
      // gets the md5 uuid of its id, the same rule as the v11 upgrade, so the app finds those rows under the ids it uses.
      // Damage reports share their DAMAGED movement's id; data without them gets them made from those movements.
      const ledgers = { ...data, damageReports: damageReportsFor(data) };
      for (const name of LEDGERS)
        for (const row of ledgers[name] ?? []) await (tx[name] as AppendOnlyRepo<Row>).append({ ...row, id: asHistoryId(String(row.id)) });
      for (const s of data.sequences ?? []) await q(`INSERT INTO id_counters (name, last_value) VALUES ($1, $2)`, [s.id, s.value]);
      for (const s of data.settings ?? []) await q(`INSERT INTO settings (id, data) VALUES ($1, $2::jsonb)`, [s.id, JSON.stringify(s)]);
    });
  }

  /** Works on a database with an older schema too (seed, import, chain conversion): it is upgraded with the new data. */
  async reset(data: DbSnapshot): Promise<void> {
    const d = await this.connection();
    await this.load(d, data, await schemaVersion(d));
  }

  async ping(): Promise<void> {
    await (await this.driver()).query(`SELECT 1`);
  }

  async snapshot(): Promise<DbSnapshot> {
    // A database with an older schema is read as it is (the chain conversion reads a v1 database,
    // which the v2 schema refuses to upgrade until its data is converted).
    const raw = await this.connection();
    const version = await schemaVersion(raw);
    // v2 → v3 only adds columns and triggers, so a v2 database is upgraded first and read normally.
    const d = version && version < 2 ? raw : await this.driver();
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
      exists: async (where) => (await read()).exists(where),
      create: write((r, row: R) => r.create(row)),
      createMany: write((r, rows: R[]) => r.createMany(rows)),
      update: write((r, id: string, patch: Partial<Omit<R, "id">>) => r.update(id, patch)),
      updateWhere: write((r, where: Where<R>, patch: Partial<Omit<R, "id">>) => r.updateWhere(where, patch)),
      delete: write((r, id: string) => r.delete(id)),
    };
  }

  private ledger<R extends Row>(name: (typeof LEDGERS)[number]): AppendOnlyRepo<R> {
    const read = async () => makeTx((await this.driver()).query)[name] as unknown as AppendOnlyRepo<R>;
    return {
      list: async (where, opts) => (await read()).list(where, opts),
      exists: async (where) => (await read()).exists(where),
      append: (row) => this.transaction((tx) => (tx[name] as unknown as AppendOnlyRepo<R>).append(row)),
    };
  }

  appendMovements(ms: NewMovement[]) {
    return this.transaction((tx) => tx.appendMovements(ms));
  }

  countries = this.repo<DbSnapshot["countries"][number]>("countries");
  flavours = this.repo<DbSnapshot["flavours"][number]>("flavours");
  partners = this.repo<DbSnapshot["partners"][number]>("partners");
  users = this.repo<DbSnapshot["users"][number]>("users");
  devices = this.repo<DbSnapshot["devices"][number]>("devices");
  batchCodePool = this.repo<DbSnapshot["batchCodePool"][number]>("batchCodePool");
  batches = this.repo<DbSnapshot["batches"][number]>("batches");
  printOrders = this.repo<DbSnapshot["printOrders"][number]>("printOrders");
  containers = this.repo<DbSnapshot["containers"][number]>("containers");
  lots = this.repo<DbSnapshot["lots"][number]>("lots");
  packs = this.repo<DbSnapshot["packs"][number]>("packs");
  movements = this.ledger<DbSnapshot["movements"][number]>("movements");
  scans = this.ledger<DbSnapshot["scans"][number]>("scans");
  reprints = this.ledger<DbSnapshot["reprints"][number]>("reprints");
  damageReports = this.ledger<DamageReport>("damageReports");
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
  async recentScans(limit: number) {
    return makeTx((await this.driver()).query).recentScans(limit);
  }
  async latestContainerWithLot(toId: string, lotCode: string, statuses: readonly ContainerStatus[]) {
    return makeTx((await this.driver()).query).latestContainerWithLot(toId, lotCode, statuses);
  }
  async historyAtPartner(partnerId: string) {
    return makeTx((await this.driver()).query).historyAtPartner(partnerId);
  }
  async stockSummary() {
    const d = await this.driver();
    const rows = await makeTx(d.query).stockSummary();
    this.maybeRollupStock(d);
    return rows;
  }
  updateSettings(patch: Partial<Omit<Settings, "id">>) {
    return this.transaction((tx) => tx.updateSettings(patch));
  }
}
