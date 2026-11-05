// Database connections behind one small interface, so the SQL store doesn't care which it talks to:
// - postgres: a real PostgreSQL server (DATABASE_URL), through the `pg` connection pool;
// - pglite:   PostgreSQL compiled to WebAssembly, running inside this process (tests, or a local
//             trial with PGLITE_DIR) — same SQL, no server to install.

/** Run one statement with $1, $2 … parameters and return its rows. */
export type Query = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

export interface SqlDriver {
  /** Where the data lives, for log lines ("PostgreSQL db.example.com/velza"). Never includes a password. */
  readonly label: string;
  query: Query;
  /** Several statements at once (the schema). */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` in one transaction: all its statements commit together or none do. `exec` runs several
   * statements at once inside it (the schema upgrade of a reset).
   */
  transaction<T>(fn: (q: Query, exec: (sql: string) => Promise<void>) => Promise<T>, opts?: { lockKey?: string }): Promise<T>;
  close(): Promise<void>;
}

/** How long a transaction waits for its allocation lock before answering "busy". */
const LOCK_WAIT_MS = Number(process.env.VELZA_ALLOCATION_LOCK_WAIT_MS ?? 30_000);

/** Raised when the allocation lock could not be taken in time; nothing was done, retrying is safe. */
export class LockTimeoutError extends Error {
  code = "55P03"; // lock_not_available
  constructor(key: string) {
    super(`Timed out after ${LOCK_WAIT_MS} ms waiting for the allocation lock "${key}"`);
    this.name = "LockTimeoutError";
  }
}

/**
 * Statements of one transaction share one connection, so they must run one after another even when the
 * caller starts several at once (Promise.all): pg@9 stops queueing them itself. Every query of a
 * transaction goes through this.
 */
export function sequential(q: Query): Query {
  let tail: Promise<unknown> = Promise.resolve();
  return (sql, params) => {
    const run = tail.then(() => q(sql, params));
    tail = run.catch(() => undefined);
    return run as never;
  };
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** "postgres://user:secret@db.example.com:5432/velza?sslmode=require" → "PostgreSQL db.example.com:5432/velza". */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `PostgreSQL ${u.host}${u.pathname}`;
  } catch {
    return "PostgreSQL (DATABASE_URL)";
  }
}

// Serialization failure / deadlock: another transaction touched the same rows; running again is safe.
const RETRYABLE = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 5;

export async function createPgDriver(url: string): Promise<SqlDriver> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  // An idle connection dropped by the server must not crash the app; the pool replaces it.
  pool.on("error", (e) => console.error("[velza] PostgreSQL connection error:", e.message));
  const query: Query = async (sql, params) => (await pool.query(sql, params as unknown[])).rows;
  return {
    label: describeDatabaseUrl(url),
    query,
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn, opts) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        let locked = false;
        let broken = false;
        try {
          if (opts?.lockKey) {
            // A session advisory lock taken BEFORE BEGIN: transactions with the same key (code allocation
            // of one manufacturer) wait for each other, across every app process, and each starts with a
            // fresh snapshot — so they queue instead of failing with serialization errors.
            const deadline = Date.now() + LOCK_WAIT_MS;
            for (;;) {
              const [row] = (await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [opts.lockKey])).rows;
              if (row?.ok) break;
              if (Date.now() > deadline) throw new LockTimeoutError(opts.lockKey);
              await new Promise((r) => setTimeout(r, 15 + Math.random() * 20));
            }
            locked = true;
          }
          // Serializable: concurrent scans of the same code can't both succeed (as with the JSON file's lock).
          await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
          const result = await fn(
            sequential(async (sql, params) => (await client.query(sql, params as unknown[])).rows),
            async (sql) => {
              await client.query(sql); // no parameters: the simple protocol, which takes several statements
            },
          );
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          const code = (e as { code?: string }).code;
          if (!code || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw e;
          await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20));
        } finally {
          if (locked) {
            // Never return a connection to the pool still holding the lock: drop it if unlocking fails.
            await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [opts!.lockKey]).catch(() => {
              broken = true;
            });
          }
          client.release(broken);
        }
      }
    },
    close: () => pool.end(),
  };
}

/** `dir` = a data directory to keep the database in; omit for a throwaway in-memory database. */
export async function createPgliteDriver(dir?: string): Promise<SqlDriver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dir);
  await db.waitReady;
  // One connection: transactions take turns. Plain reads don't wait (they see the open transaction).
  const lock = new Mutex();
  const query: Query = async (sql, params) => (await db.query(sql, params as unknown[])).rows as never[];
  return {
    label: dir ? `PostgreSQL (embedded) in ${dir}` : "PostgreSQL (embedded, in memory)",
    query,
    async exec(sql) {
      await db.exec(sql);
    },
    transaction: (fn) =>
      lock.run(async () => {
        // One connection and one transaction at a time: the allocation lock key is already satisfied.
        await db.exec("BEGIN");
        try {
          const result = await fn(sequential(query), async (sql) => {
            await db.exec(sql);
          });
          await db.exec("COMMIT");
          return result;
        } catch (e) {
          await db.exec("ROLLBACK");
          throw e;
        }
      }),
    close: () => db.close(),
  };
}
