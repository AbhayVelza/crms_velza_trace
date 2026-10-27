// npm run db:schema → write the PostgreSQL schema to db/schema.sql (for review by a database
// administrator, or to create the tables by hand). The app applies the same SQL itself.

import { promises as fs } from "node:fs";
import path from "node:path";
import { schemaFile } from "@/lib/store/sql/schema";

async function main() {
  const file = path.join(process.cwd(), "db", "schema.sql");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, schemaFile(), "utf8");
  console.log(`Wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
