import { describe, expect, it } from "vitest";
import { databaseUrl } from "./index";

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
