// Which connection pool each transaction uses (pg is replaced by a recording fake: no server needed).
import { beforeEach, describe, expect, it, vi } from "vitest";

const pools: FakePool[] = [];

class FakePool {
  sql: string[] = [];
  ended = false;
  constructor(public opts: { connectionString: string; max: number }) {
    pools.push(this);
  }
  on() {}
  async query(sql: string) {
    this.sql.push(sql);
    return { rows: [] };
  }
  async connect() {
    return {
      query: async (sql: string) => {
        this.sql.push(sql);
        return { rows: sql.includes("pg_try_advisory_lock") ? [{ ok: true }] : [] };
      },
      release: () => undefined,
    };
  }
  async end() {
    this.ended = true;
  }
}

vi.mock("pg", () => ({ default: { Pool: FakePool } }));

const { createPgDriver } = await import("./driver");

beforeEach(() => {
  pools.length = 0;
});

describe("createPgDriver connection pools", () => {
  it("separate direct address: only lock-key transactions use it, through a small pool opened on first use", async () => {
    const d = await createPgDriver("postgres://pooler/db", { max: 3, lockUrl: "postgres://direct/db", lockMax: 2 });
    expect(pools.map((p) => p.opts)).toEqual([{ connectionString: "postgres://pooler/db", max: 3 }]);

    await d.query("SELECT 1");
    await d.transaction(async (q) => q("SELECT 'scan'"));
    expect(pools).toHaveLength(1); // ordinary work never opens the direct pool

    await d.transaction(async (q) => q("SELECT 'allocate'"), { lockKey: "alloc:MF0001" });
    expect(pools).toHaveLength(2);
    const [main, lock] = pools;
    expect(lock.opts).toEqual({ connectionString: "postgres://direct/db", max: 2 });
    // The session lock, the transaction and the unlock all ran on the direct pool's connection.
    expect(lock.sql).toEqual([
      expect.stringContaining("pg_try_advisory_lock"),
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "SELECT 'allocate'",
      "COMMIT",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
    expect(main.sql).toEqual(["SELECT 1", "BEGIN ISOLATION LEVEL SERIALIZABLE", "SELECT 'scan'", "COMMIT"]);
    expect(main.sql.join(" ")).not.toContain("advisory");

    await d.transaction(async (q) => q("SELECT 'again'"), { lockKey: "alloc:MF0001" });
    expect(pools).toHaveLength(2); // reused, not reopened

    await d.close();
    expect(pools.every((p) => p.ended)).toBe(true);
  });

  it("same address (Docker, Lightsail, laptop): one pool for everything, as before", async () => {
    const d = await createPgDriver("postgres://a/db", { max: 10, lockUrl: "postgres://a/db", lockMax: 2 });
    await d.transaction(async (q) => q("SELECT 'allocate'"), { lockKey: "alloc:MF0001" });
    await d.transaction(async (q) => q("SELECT 'scan'"));
    expect(pools).toHaveLength(1);
    expect(pools[0].opts).toEqual({ connectionString: "postgres://a/db", max: 10 });
    expect(pools[0].sql[0]).toContain("pg_try_advisory_lock");
    await d.close();
    expect(pools[0].ended).toBe(true);
  });

  it("no lock address given: one pool (older callers)", async () => {
    const d = await createPgDriver("postgres://a/db");
    await d.transaction(async (q) => q("SELECT 1"), { lockKey: "k" });
    expect(pools).toHaveLength(1);
    await d.close();
  });
});
