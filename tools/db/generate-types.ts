/**
 * Writes `src/lib/server/db/schema.ts`, the row types Kysely checks every
 * query against, from the schema itself: an in-memory PGlite, the same
 * migrations a deployed database runs, then `pg_attribute`. Row types are
 * never kept by hand; `db/schema.test.ts` regenerates in memory and fails
 * when the committed file differs.
 *
 *   npm run db:types
 *
 * Two project rules ride on the types:
 * - a generated column (`generated always as`, `generated always as
 *   identity`) is `GeneratedAlways`, so writing one is a type error;
 * - a jsonb column takes only `JsonParam`, which `json()` alone makes, so a
 *   raw JS array (which `pg` would send as a Postgres array) cannot be written.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { applyMigrations } from "../../src/lib/server/db/migrations";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SCHEMA_TYPES_FILE = path.join(ROOT, "src", "lib", "server", "db", "schema.ts");

/** Tables the app never queries through these types. */
const SKIPPED_TABLES = new Set(["schema_migrations"]);

interface ColumnRow {
  table_name: string;
  column_name: string;
  type_name: string;
  element_type: string | null;
  not_null: boolean;
  has_default: boolean;
  generated: string;
  identity: string;
}

/** Postgres type to the TypeScript type a row holds, as `DB_TYPE_PARSERS` and the drivers read it. */
const SCALAR_TYPES: Record<string, string> = {
  bool: "boolean",
  int2: "number",
  int4: "number",
  // `DB_TYPE_PARSERS` reads bigint as a number, as PostgREST answered it.
  int8: "number",
  float4: "number",
  float8: "number",
  // Exact decimals stay text: a JS number would round them.
  numeric: "string",
  text: "string",
  varchar: "string",
  bpchar: "string",
  citext: "string",
  uuid: "string",
  // `DB_TYPE_PARSERS` reads timestamptz as JSON text in UTC.
  timestamptz: "string",
  inet: "string",
};

function scalarType(name: string, table: string, column: string): string {
  const type = SCALAR_TYPES[name];
  if (!type) {
    // A new type needs a deliberate mapping (and a parser if the drivers differ).
    throw new Error(`${table}.${column}: no TypeScript type for Postgres type ${name}`);
  }
  return type;
}

function columnType(row: ColumnRow): string {
  const nullable = row.not_null ? "" : " | null";
  const alwaysGenerated = row.generated === "s" || row.identity === "a";
  const defaulted = row.has_default || row.identity === "d";
  if (row.type_name === "jsonb" || row.type_name === "json") {
    if (alwaysGenerated) {
      return `GeneratedAlways<JsonValue${nullable}>`;
    }
    const insert = `JsonParam${nullable}${defaulted ? " | undefined" : ""}`;
    return `ColumnType<JsonValue${nullable}, ${insert}, JsonParam${nullable}>`;
  }
  const base = row.element_type
    ? `${scalarType(row.element_type, row.table_name, row.column_name)}[]`
    : scalarType(row.type_name, row.table_name, row.column_name);
  const select = `${base}${nullable}`;
  if (alwaysGenerated) {
    return `GeneratedAlways<${select}>`;
  }
  return defaulted ? `Generated<${select}>` : select;
}

const pascal = (name: string): string =>
  name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/** The schema's row types as the text of `schema.ts`, read from a database the migrations built. */
export async function readSchemaTypes(db: PGlite): Promise<string> {
  const { rows } = await db.query<ColumnRow>(
    `select c.relname as table_name,
            a.attname as column_name,
            t.typname as type_name,
            e.typname as element_type,
            a.attnotnull as not_null,
            a.atthasdef as has_default,
            a.attgenerated::text as generated,
            a.attidentity::text as identity
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
       left join pg_type e on e.oid = t.typelem and t.typcategory = 'A'
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attnum`,
  );
  const tables = new Map<string, ColumnRow[]>();
  for (const row of rows) {
    if (SKIPPED_TABLES.has(row.table_name)) continue;
    const columns = tables.get(row.table_name) ?? [];
    columns.push(row);
    tables.set(row.table_name, columns);
  }
  const names = [...tables.keys()].sort();
  const lines = [
    "/**",
    " * The database's row types, generated from the migrations by",
    " * tools/db/generate-types.ts. Never edit by hand: change the SQL, then run",
    " * `npm run db:types` (db/schema.test.ts fails while this file is stale).",
    " */",
    'import type { ColumnType, Generated, GeneratedAlways } from "kysely";',
    'import type { JsonParam } from "./parsers";',
    "",
    "export type JsonValue =",
    "  | string",
    "  | number",
    "  | boolean",
    "  | null",
    "  | JsonValue[]",
    "  | { [key: string]: JsonValue };",
    "",
  ];
  for (const name of names) {
    lines.push(`export interface ${pascal(name)}Table {`);
    for (const column of tables.get(name)!) {
      lines.push(`  ${column.column_name}: ${columnType(column)};`);
    }
    lines.push("}", "");
  }
  lines.push("export interface Database {");
  for (const name of names) {
    lines.push(`  ${name}: ${pascal(name)}Table;`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

/** Builds a fresh in-memory database from the migrations and reads its types. */
export async function generateSchemaTypes(): Promise<string> {
  const db = new PGlite();
  try {
    await applyMigrations(db, path.join(ROOT, "supabase"));
    return await readSchemaTypes(db);
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  writeFileSync(SCHEMA_TYPES_FILE, await generateSchemaTypes());
  console.log(`wrote ${path.relative(ROOT, SCHEMA_TYPES_FILE)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
