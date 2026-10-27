import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { schemaFile } from "./schema";

describe("db/schema.sql", () => {
  it("matches the schema the app applies (run `npm run db:schema` after changing schema.ts)", () => {
    const file = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8").replace(/\r\n/g, "\n");
    expect(file).toBe(schemaFile());
  });
});
