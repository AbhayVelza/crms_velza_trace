import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseUrl, databaseUrls, describeStore } from "./index";

describe("databaseUrl", () => {
  it("is undefined when neither variable is set (JSON store)", () => {
    expect(databaseUrl({})).toBeUndefined();
    expect(databaseUrl({ DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" })).toBeUndefined();
  });

  it("uses DATABASE_URL on its own", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a/db" })).toBe("postgres://a/db");
  });

  it("prefers the direct DATABASE_URL_UNPOOLED over the pooled DATABASE_URL (Neon on Vercel)", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://pooler/db", DATABASE_URL_UNPOOLED: "postgres://direct/db" })).toBe("postgres://direct/db");
  });

  it("falls back to DATABASE_URL when DATABASE_URL_UNPOOLED is empty", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a/db", DATABASE_URL_UNPOOLED: "" })).toBe("postgres://a/db");
  });
});

describe("databaseUrls: which address each kind of work uses", () => {
  it("is undefined without a database (JSON store)", () => {
    expect(databaseUrls({})).toBeUndefined();
    expect(databaseUrls({ DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" })).toBeUndefined();
  });

  it("Neon on Vercel: ordinary work on the pooled DATABASE_URL, code allocation on the direct DATABASE_URL_UNPOOLED", () => {
    const urls = databaseUrls({ VERCEL: "1", DATABASE_URL: "postgres://pooler/db", DATABASE_URL_UNPOOLED: "postgres://direct/db" });
    expect(urls).toEqual({ query: "postgres://pooler/db", lock: "postgres://direct/db", poolMax: 3, lockPoolMax: 2 });
  });

  it("Docker / Lightsail / laptop: one address for everything, one pool of 10 as before", () => {
    expect(databaseUrls({ DATABASE_URL: "postgres://a/db" })).toEqual({ query: "postgres://a/db", lock: "postgres://a/db", poolMax: 10, lockPoolMax: 2 });
  });

  it("only DATABASE_URL_UNPOOLED set: it is used for everything", () => {
    expect(databaseUrls({ DATABASE_URL_UNPOOLED: "postgres://direct/db" })).toMatchObject({ query: "postgres://direct/db", lock: "postgres://direct/db" });
  });

  it("PG_POOL_MAX and PG_LOCK_POOL_MAX override the defaults, on Vercel and off it; junk values keep the default", () => {
    expect(databaseUrls({ VERCEL: "1", DATABASE_URL: "postgres://p/db", PG_POOL_MAX: "5", PG_LOCK_POOL_MAX: "1" })).toMatchObject({ poolMax: 5, lockPoolMax: 1 });
    expect(databaseUrls({ DATABASE_URL: "postgres://p/db", PG_POOL_MAX: "20" })).toMatchObject({ poolMax: 20 });
    expect(databaseUrls({ VERCEL: "1", DATABASE_URL: "postgres://p/db", PG_POOL_MAX: "", PG_LOCK_POOL_MAX: "zero" })).toMatchObject({ poolMax: 3, lockPoolMax: 2 });
    expect(databaseUrls({ DATABASE_URL: "postgres://p/db", PG_POOL_MAX: "0" })).toMatchObject({ poolMax: 10 });
  });
});

describe("describeStore", () => {
  afterEach(() => vi.unstubAllEnvs());
  const env = (vars: Record<string, string>) => {
    for (const k of ["STORE", "VERCEL", "DATABASE_URL", "DATABASE_URL_UNPOOLED", "VELZA_DB_PATH"]) vi.stubEnv(k, "");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  };

  it("names both addresses when code allocation uses a separate direct one, never a password", () => {
    env({ DATABASE_URL: "postgres://u:secret@ep-x-pooler.neon.tech/velza", DATABASE_URL_UNPOOLED: "postgres://u:secret@ep-x.neon.tech/velza" });
    const d = describeStore();
    expect(d).toBe("PostgreSQL ep-x-pooler.neon.tech/velza (code allocation: ep-x.neon.tech/velza)");
    expect(d).not.toContain("secret");
  });

  it("names one address when everything uses it", () => {
    env({ STORE: "postgres", DATABASE_URL: "postgres://u:secret@db.example.com:5432/velza" });
    expect(describeStore()).toBe("PostgreSQL db.example.com:5432/velza");
  });
});
