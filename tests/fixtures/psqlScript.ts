// Runs a psql script (the repo's .sql files: deploy/roles_v11.sql, tests/sql/*, migration/*.sql) on embedded PostgreSQL
// in tests, so the very files a human runs with psql are what the tests check. Understands the psql features those files
// use: :'name' variables, \gexec, \ir (include, relative to the file), and \set / \pset / \echo (ignored). Anything else
// starting with a backslash is refused, so a script can't silently do less here than under psql.
//
// Statements are split at a line ending in ";" (outside dollar quotes and ignoring a trailing -- comment) and run one by
// one, like psql: BEGIN / COMMIT in a script work across statements.

import { readFileSync } from "node:fs";
import path from "node:path";

export interface ScriptDb {
  exec(sql: string): Promise<unknown>;
  query<R = Record<string, unknown>>(sql: string): Promise<{ rows: R[] }>;
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** The line without a trailing -- comment (only when the -- is outside a '…' string). */
function withoutComment(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") inString = !inString;
    else if (!inString && c === "-" && line[i + 1] === "-") return line.slice(0, i);
  }
  return line;
}

interface Step {
  sql: string;
  gexec: boolean;
}

/** Statements of a psql script (includes resolved). */
export function psqlSteps(file: string, vars: Record<string, string> = {}): Step[] {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const steps: Step[] = [];
  let buf: string[] = [];
  let dollar: string | null = null; // the open dollar-quote tag, if any
  const flush = (gexec: boolean) => {
    const sql = buf.join("\n").trim();
    if (sql) steps.push({ sql, gexec });
    buf = [];
  };
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!dollar && !buf.length && trimmed.startsWith("\\")) {
      const [cmd, arg] = trimmed.split(/\s+/, 2);
      if (cmd === "\\ir" || cmd === "\\include_relative") {
        steps.push(...psqlSteps(path.resolve(path.dirname(file), arg), vars));
        continue;
      }
      if (["\\set", "\\pset", "\\echo", "\\unset", "\\timing"].includes(cmd)) continue;
      throw new Error(`${file}: psql command ${cmd} is not supported by the test runner`);
    }
    if (!dollar && !buf.length && (trimmed === "" || trimmed.startsWith("--"))) continue;
    const line = raw.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (m, name: string) => {
      if (!(name in vars)) throw new Error(`${file}: variable ${name} is not set`);
      return quote(vars[name]);
    });
    // Dollar quotes opened and closed on this line.
    for (const tag of line.match(/\$[A-Za-z_]*\$/g) ?? []) {
      if (dollar === null) dollar = tag;
      else if (tag === dollar) dollar = null;
    }
    const end = withoutComment(line).trimEnd();
    if (!dollar && end.endsWith("\\gexec")) {
      buf.push(end.slice(0, -"\\gexec".length));
      flush(true);
    } else {
      buf.push(line);
      if (!dollar && end.endsWith(";")) flush(false);
    }
  }
  flush(false);
  return steps;
}

/** Run a psql script; \gexec runs every non-null value the query returns as a statement. */
export async function runPsqlScript(db: ScriptDb, file: string, vars: Record<string, string> = {}): Promise<void> {
  for (const step of psqlSteps(file, vars)) {
    try {
      if (!step.gexec) {
        await db.exec(step.sql);
        continue;
      }
      const { rows } = await db.query<Record<string, unknown>>(step.sql);
      for (const row of rows) for (const v of Object.values(row)) if (v !== null && v !== undefined) await db.exec(String(v));
    } catch (e) {
      throw new Error(`${path.basename(file)}: ${(e as Error).message}\n--- statement:\n${step.sql.slice(0, 600)}`, { cause: e });
    }
  }
}
