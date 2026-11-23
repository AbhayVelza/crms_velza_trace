import { describe, expect, it } from "vitest";
import { storeKind } from "./index";

describe("storeKind", () => {
  it("defaults to the JSON store, and to PostgreSQL when a database URL is set", () => {
    expect(storeKind({})).toBe("json");
    expect(storeKind({ DATABASE_URL: "postgres://a/db" })).toBe("postgres");
    expect(storeKind({ STORE: "pglite" })).toBe("pglite");
  });

  it("refuses an unknown STORE", () => {
    expect(() => storeKind({ STORE: "sqlite" })).toThrow(/Unsupported STORE "sqlite"/);
  });

  it("refuses the JSON store on Vercel", () => {
    expect(() => storeKind({ VERCEL: "1" })).toThrow(/On Vercel connect a PostgreSQL database.*JSON store needs a real disk/);
    expect(() => storeKind({ VERCEL: "1", STORE: "json", DATABASE_URL: "postgres://a/db" })).toThrow(/On Vercel/);
  });

  it("refuses embedded PostgreSQL (STORE=pglite) on Vercel: each instance would have its own empty database", () => {
    expect(() => storeKind({ VERCEL: "1", STORE: "pglite" })).toThrow(/On Vercel connect a PostgreSQL database.*STORE=pglite/);
    expect(() => storeKind({ VERCEL: "1", STORE: "pglite", DATABASE_URL: "postgres://a/db" })).toThrow(/STORE=pglite/);
  });

  it("allows PostgreSQL on Vercel", () => {
    expect(storeKind({ VERCEL: "1", DATABASE_URL: "postgres://pooler/db" })).toBe("postgres");
    expect(storeKind({ VERCEL: "1", STORE: "postgres", DATABASE_URL_UNPOOLED: "postgres://direct/db" })).toBe("postgres");
  });

  it("allows embedded PostgreSQL off Vercel (tests, local trials)", () => {
    expect(storeKind({ STORE: "pglite", PGLITE_DIR: "./data/pg" })).toBe("pglite");
  });
});
