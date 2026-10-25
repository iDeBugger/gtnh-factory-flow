/**
 * A PostgREST stand-in for local development: the HTTP requests the server's
 * PostgREST client makes (`/rest/v1/<table>`), answered from a real Postgres
 * (PGlite) so the server code runs unchanged against a database on this
 * machine.
 *
 * It covers what this codebase sends, the way PostgREST answers it: select
 * lists, filters (eq, neq, gt, gte, lt, lte, like, ilike, match, imatch, is,
 * isdistinct, in, cs, cd, each with not.), or/and trees, order with nulls
 * first/last, limit and offset, counts (Prefer: count=exact, HEAD),
 * single-object answers, inserts and upserts (on_conflict, merge or ignore),
 * updates and deletes with return=representation or minimal. Rows come out
 * through Postgres's own json_agg, as PostgREST does, so timestamps and
 * numbers read exactly as the hosted service writes them. Errors carry
 * Postgres's code (or PostgREST's PGRST codes) and PostgREST's status.
 *
 * Every identifier is checked against the catalogue and quoted; every value
 * is a bound parameter cast from text to its column's type.
 */

export interface SqlDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<unknown>;
}

interface TableInfo {
  columns: Map<string, { type: string; generated: boolean }>;
  primaryKey: string[];
}

interface PostgrestErrorBody {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: PostgrestErrorBody,
  ) {
    super(body.message);
  }
}

function fail(status: number, code: string, message: string, details: string | null = null): never {
  throw new RequestError(status, { code, message, details, hint: null });
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    fail(400, "PGRST100", `"${name}" is not a column name this server accepts`);
  }
  return `"${name}"`;
}

/** Postgres error codes to PostgREST's HTTP statuses. */
function statusForPgCode(code: string | undefined): number {
  switch (code) {
    case "23505": // unique_violation
    case "23503": // foreign_key_violation
    case "23P01": // exclusion_violation
      return 409;
    case "42P01": // undefined_table
      return 404;
    case "42501": // insufficient_privilege
      return 403;
    case "57014": // query_canceled (statement timeout)
      return 500;
    default:
      return code && /^(08|53|54|55|57|58|XX)/.test(code) ? 500 : 400;
  }
}

// ---------------------------------------------------------------------------
// Parsing PostgREST's query language

type Condition =
  | { kind: "filter"; column: string; negate: boolean; op: string; value: string }
  | { kind: "logic"; negate: boolean; op: "and" | "or"; items: Condition[] };

/** Splits on commas outside parentheses and double quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      current += char;
      if (char === "\\" && i + 1 < text.length) {
        current += text[i + 1];
        i += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** A value as PostgREST reads it: a double-quoted one loses its quotes and escapes. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/** `[not.]op.value` after the column. */
function parseOperation(column: string, text: string): Condition {
  let rest = text;
  let negate = false;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf(".");
  if (dot < 0) {
    fail(400, "PGRST100", `"failed to parse filter (${text})" (line 1, column 1)`);
  }
  return { kind: "filter", column, negate, op: rest.slice(0, dot), value: rest.slice(dot + 1) };
}

function parseLogic(op: "and" | "or", negate: boolean, text: string): Condition {
  if (!text.startsWith("(") || !text.endsWith(")")) {
    fail(400, "PGRST100", `"failed to parse logic tree (${text})" (line 1, column 1)`);
  }
  const items = splitTopLevel(text.slice(1, -1)).map((item) => parseLogicItem(item.trim()));
  return { kind: "logic", negate, op, items };
}

function parseLogicItem(item: string): Condition {
  const logic = /^(not\.)?(and|or)(\(.*\))$/s.exec(item);
  if (logic) {
    return parseLogic(logic[2] as "and" | "or", Boolean(logic[1]), logic[3]!);
  }
  const dot = item.indexOf(".");
  if (dot < 0) {
    fail(400, "PGRST100", `"failed to parse logic tree (${item})" (line 1, column 1)`);
  }
  return parseOperation(item.slice(0, dot), item.slice(dot + 1));
}

const RESERVED_PARAMS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

interface ParsedRequest {
  select: string[] | "*";
  conditions: Condition[];
  order: Array<{ column: string; descending: boolean; nulls?: "first" | "last" }>;
  limit?: number;
  offset?: number;
  onConflict?: string[];
  columns?: string[];
}

function parseInteger(name: string, value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    fail(400, "PGRST100", `"failed to parse ${name} (${value})" (line 1, column 1)`);
  }
  return Number(value);
}

function parseColumnList(value: string): string[] {
  return value
    .split(",")
    .map((name) => unquote(name.trim()))
    .filter(Boolean);
}

function parseRequest(url: URL): ParsedRequest {
  const params = url.searchParams;
  const conditions: Condition[] = [];
  for (const [key, value] of params) {
    if (RESERVED_PARAMS.has(key)) {
      continue;
    }
    const logic = /^(not\.)?(and|or)$/.exec(key);
    if (logic) {
      conditions.push(parseLogic(logic[2] as "and" | "or", Boolean(logic[1]), value));
    } else if (key.includes(".")) {
      fail(400, "PGRST108", `Filters on embedded resources are not supported here: ${key}`);
    } else {
      conditions.push(parseOperation(key, value));
    }
  }
  const selectParam = params.get("select");
  let select: string[] | "*" = "*";
  if (selectParam !== null && selectParam !== "" && selectParam !== "*") {
    if (selectParam.includes("(")) {
      fail(400, "PGRST100", "Embedded resources are not supported by the local database");
    }
    select = parseColumnList(selectParam);
  }
  const order: ParsedRequest["order"] = [];
  const orderParam = params.get("order");
  if (orderParam) {
    for (const term of orderParam.split(",")) {
      const [column, ...modifiers] = term.split(".");
      let descending = false;
      let nulls: "first" | "last" | undefined;
      for (const modifier of modifiers) {
        if (modifier === "desc") descending = true;
        else if (modifier === "asc") descending = false;
        else if (modifier === "nullsfirst") nulls = "first";
        else if (modifier === "nullslast") nulls = "last";
        else fail(400, "PGRST100", `"failed to parse order (${orderParam})" (line 1, column 1)`);
      }
      order.push({ column: column!, descending, nulls });
    }
  }
  const onConflict = params.get("on_conflict");
  const columns = params.get("columns");
  return {
    select,
    conditions,
    order,
    limit: parseInteger("limit", params.get("limit")),
    offset: parseInteger("offset", params.get("offset")),
    onConflict: onConflict ? parseColumnList(onConflict) : undefined,
    columns: columns ? parseColumnList(columns) : undefined,
  };
}

interface Prefer {
  representation: boolean;
  count: boolean;
  resolution?: "merge" | "ignore";
}

function parsePrefer(headers: Headers): Prefer {
  const values = (headers.get("prefer") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const prefer: Prefer = { representation: false, count: false };
  for (const value of values) {
    if (value === "return=representation") prefer.representation = true;
    else if (value === "return=minimal") prefer.representation = false;
    else if (/^count=(exact|planned|estimated)$/.test(value)) prefer.count = true;
    else if (value === "resolution=merge-duplicates") prefer.resolution = "merge";
    else if (value === "resolution=ignore-duplicates") prefer.resolution = "ignore";
  }
  return prefer;
}

// ---------------------------------------------------------------------------
// Building SQL

class SqlBuilder {
  readonly params: unknown[] = [];

  constructor(
    private readonly tableName: string,
    private readonly table: TableInfo,
  ) {}

  get qualified(): string {
    return quoteIdent(this.tableName);
  }

  column(name: string): string {
    if (!this.table.columns.has(name)) {
      fail(400, "42703", `column ${this.tableName}.${name} does not exist`);
    }
    return `${this.qualified}.${quoteIdent(name)}`;
  }

  typeOf(name: string): string {
    return this.table.columns.get(name)!.type;
  }

  /** A parameter cast from text to the column's own type. */
  value(column: string, value: string, type = this.typeOf(column)): string {
    this.params.push(value);
    return `cast($${this.params.length}::text as ${type})`;
  }

  textParam(value: string): string {
    this.params.push(value);
    return `$${this.params.length}::text`;
  }

  jsonParam(value: unknown): string {
    this.params.push(JSON.stringify(value));
    return `$${this.params.length}::json`;
  }

  condition(condition: Condition): string {
    if (condition.kind === "logic") {
      const joined =
        condition.items.length === 0
          ? "true"
          : condition.items
              .map((item) => `(${this.condition(item)})`)
              .join(condition.op === "and" ? " and " : " or ");
      return condition.negate ? `not (${joined})` : joined;
    }
    const sql = this.filter(condition.column, condition.op, condition.value);
    return condition.negate ? `not (${sql})` : sql;
  }

  private filter(columnName: string, op: string, raw: string): string {
    const column = this.column(columnName);
    const value = unquote(raw);
    switch (op) {
      case "eq":
        return `${column} = ${this.value(columnName, value)}`;
      case "neq":
        return `${column} <> ${this.value(columnName, value)}`;
      case "gt":
        return `${column} > ${this.value(columnName, value)}`;
      case "gte":
        return `${column} >= ${this.value(columnName, value)}`;
      case "lt":
        return `${column} < ${this.value(columnName, value)}`;
      case "lte":
        return `${column} <= ${this.value(columnName, value)}`;
      case "like":
        return `${column}::text like ${this.textParam(value.replace(/\*/g, "%"))}`;
      case "ilike":
        return `${column}::text ilike ${this.textParam(value.replace(/\*/g, "%"))}`;
      case "match":
        return `${column}::text ~ ${this.textParam(value)}`;
      case "imatch":
        return `${column}::text ~* ${this.textParam(value)}`;
      case "is": {
        const keyword = value.toLowerCase();
        if (!["null", "true", "false", "unknown", "not_null"].includes(keyword)) {
          fail(400, "PGRST100", `"failed to parse filter (is.${value})" (line 1, column 4)`);
        }
        return keyword === "not_null" ? `${column} is not null` : `${column} is ${keyword}`;
      }
      case "isdistinct":
        return `${column} is distinct from ${this.value(columnName, value)}`;
      case "in": {
        if (!raw.startsWith("(") || !raw.endsWith(")")) {
          fail(400, "PGRST100", `"failed to parse filter (in.${raw})" (line 1, column 4)`);
        }
        const inner = raw.slice(1, -1);
        const items = inner === "" ? [] : splitTopLevel(inner).map((item) => unquote(item.trim()));
        if (items.length === 0) {
          return "false";
        }
        return `${column} in (${items.map((item) => this.value(columnName, item)).join(", ")})`;
      }
      case "cs":
        return `${column} @> ${this.value(columnName, value)}`;
      case "cd":
        return `${column} <@ ${this.value(columnName, value)}`;
      default:
        fail(400, "PGRST100", `"unknown operator ${op}" (line 1, column 1)`);
    }
  }

  where(conditions: Condition[]): string {
    if (conditions.length === 0) {
      return "";
    }
    return ` where ${conditions.map((condition) => `(${this.condition(condition)})`).join(" and ")}`;
  }

  selectList(select: string[] | "*"): string {
    if (select === "*") {
      return `${this.qualified}.*`;
    }
    return select
      .map((item) => {
        const colon = item.indexOf(":");
        // `alias:column`, but not a `::cast`.
        if (colon > 0 && item[colon + 1] !== ":") {
          return `${this.column(item.slice(colon + 1))} as ${quoteIdent(item.slice(0, colon))}`;
        }
        if (item.includes("::")) {
          fail(400, "PGRST100", "Casts in select are not supported by the local database");
        }
        return `${this.column(item)} as ${quoteIdent(item)}`;
      })
      .join(", ");
  }

  orderBy(order: ParsedRequest["order"]): string {
    if (order.length === 0) {
      return "";
    }
    const terms = order.map(
      (term) =>
        `${this.column(term.column)} ${term.descending ? "desc" : "asc"}${term.nulls ? ` nulls ${term.nulls}` : ""}`,
    );
    return ` order by ${terms.join(", ")}`;
  }
}

// ---------------------------------------------------------------------------
// The handler

export interface PostgrestHandler {
  (request: Request): Promise<Response>;
  /** Re-reads the catalogue, after a migration. */
  reloadSchema(): Promise<void>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function contentRange(offset: number, rows: number, total: number | undefined): string {
  const range = rows > 0 ? `${offset}-${offset + rows - 1}` : "*";
  return `${range}/${total === undefined ? "*" : total}`;
}

const SINGLE_OBJECT = "application/vnd.pgrst.object+json";

export function createPostgrestHandler(db: SqlDatabase): PostgrestHandler {
  let schema: Promise<Map<string, TableInfo>> | undefined;

  const loadSchema = async (): Promise<Map<string, TableInfo>> => {
    const tables = new Map<string, TableInfo>();
    const { rows } = await db.query(
      `select c.relname as table_name, a.attname as column_name,
              format_type(a.atttypid, a.atttypmod) as column_type,
              (a.attgenerated <> '' or a.attidentity = 'a') as generated
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'p', 'm')
          and a.attnum > 0 and not a.attisdropped
        order by c.relname, a.attnum`,
    );
    for (const row of rows) {
      const name = String(row.table_name);
      let table = tables.get(name);
      if (!table) {
        table = { columns: new Map(), primaryKey: [] };
        tables.set(name, table);
      }
      table.columns.set(String(row.column_name), {
        type: String(row.column_type),
        generated: row.generated === true,
      });
    }
    const keys = await db.query(
      `select c.relname as table_name, a.attname as column_name
         from pg_index i
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
         join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where n.nspname = 'public' and i.indisprimary
        order by c.relname, k.ord`,
    );
    for (const row of keys.rows) {
      tables.get(String(row.table_name))?.primaryKey.push(String(row.column_name));
    }
    return tables;
  };

  const tableFor = async (name: string): Promise<{ name: string; info: TableInfo }> => {
    schema ??= loadSchema();
    const info = (await schema).get(name);
    if (!info) {
      fail(404, "PGRST205", `Could not find the table 'public.${name}' in the schema cache`);
    }
    return { name, info };
  };

  const answerRows = (
    request: Request,
    status: number,
    body: string,
    headers: Record<string, string>,
  ): Response => {
    const accept = request.headers.get("accept") ?? "";
    if (accept.startsWith(SINGLE_OBJECT)) {
      const rows = JSON.parse(body) as unknown[];
      if (rows.length !== 1) {
        return json(406, {
          code: "PGRST116",
          details: `The result contains ${rows.length} rows`,
          hint: null,
          message: "Cannot coerce the result to a single JSON object",
        });
      }
      return json(status, rows[0], headers);
    }
    return new Response(body, {
      status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
  };

  const read = async (
    request: Request,
    tableName: string,
    url: URL,
    head: boolean,
  ): Promise<Response> => {
    const { info } = await tableFor(tableName);
    const parsed = parseRequest(url);
    const prefer = parsePrefer(request.headers);
    const builder = new SqlBuilder(tableName, info);
    const columns = builder.selectList(parsed.select);
    const where = builder.where(parsed.conditions);
    const filterParams = builder.params.slice();
    let total: number | undefined;
    if (prefer.count) {
      const counted = await db.query(
        `select count(*)::bigint as n from ${builder.qualified}${where}`,
        filterParams,
      );
      total = Number(counted.rows[0]?.n ?? 0);
    }
    const offset = parsed.offset ?? 0;
    if (head) {
      return new Response(null, {
        status: 200,
        headers: { "content-range": contentRange(offset, 0, total) },
      });
    }
    const orderBy = builder.orderBy(parsed.order);
    const limit = parsed.limit !== undefined ? ` limit ${parsed.limit}` : "";
    const skip = parsed.offset !== undefined ? ` offset ${parsed.offset}` : "";
    const { rows } = await db.query(
      `select coalesce(json_agg(_postgrest_t), '[]')::text as body
         from (select ${columns} from ${builder.qualified}${where}${orderBy}${limit}${skip}) _postgrest_t`,
      builder.params,
    );
    const body = String(rows[0]?.body ?? "[]");
    const count = (JSON.parse(body) as unknown[]).length;
    return answerRows(request, 200, body, { "content-range": contentRange(offset, count, total) });
  };

  /** Runs a mutation ending in `returning ...`, and answers as PostgREST would. */
  const mutate = async (
    request: Request,
    sql: string,
    params: unknown[],
    status: { withBody: number; withoutBody: number },
  ): Promise<Response> => {
    const prefer = parsePrefer(request.headers);
    const { rows } = await db.query(
      `with _postgrest_m as (${sql}) select coalesce(json_agg(_postgrest_m), '[]')::text as body, count(*)::bigint as n from _postgrest_m`,
      params,
    );
    const body = String(rows[0]?.body ?? "[]");
    const affected = Number(rows[0]?.n ?? 0);
    const headers = {
      "content-range": contentRange(0, affected, prefer.count ? affected : undefined),
    };
    if (!prefer.representation) {
      return new Response(null, { status: status.withoutBody, headers });
    }
    return answerRows(request, status.withBody, body, headers);
  };

  const write = async (request: Request, tableName: string, url: URL): Promise<Response> => {
    const { info } = await tableFor(tableName);
    const parsed = parseRequest(url);
    const prefer = parsePrefer(request.headers);
    const builder = new SqlBuilder(tableName, info);
    const returning = builder.selectList(parsed.select);
    const method = request.method.toUpperCase();

    if (method === "DELETE") {
      const where = builder.where(parsed.conditions);
      return mutate(
        request,
        `delete from ${builder.qualified}${where} returning ${returning}`,
        builder.params,
        {
          withBody: 200,
          withoutBody: 204,
        },
      );
    }

    let payload: unknown;
    try {
      const text = await request.text();
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      fail(400, "PGRST102", "Empty or invalid json");
    }
    const checkColumns = (names: string[]) => {
      for (const name of names) {
        const column = info.columns.get(name);
        if (!column) {
          fail(
            400,
            "PGRST204",
            `Could not find the '${name}' column of '${tableName}' in the schema cache`,
          );
        }
        if (column.generated) {
          fail(
            400,
            "428C9",
            `cannot insert a non-DEFAULT value into column "${name}"`,
            `Column "${name}" is a generated column.`,
          );
        }
      }
    };

    if (method === "PATCH") {
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        fail(400, "PGRST102", "A PATCH needs one JSON object");
      }
      const names = Object.keys(payload as object);
      checkColumns(names);
      if (names.length === 0) {
        return read(request, tableName, url, false);
      }
      const record = builder.jsonParam(payload);
      const assignments = names
        .map((name) => `${quoteIdent(name)} = _postgrest_r.${quoteIdent(name)}`)
        .join(", ");
      const where = builder.where(parsed.conditions);
      return mutate(
        request,
        `update ${builder.qualified} set ${assignments}
           from json_populate_record(null::${builder.qualified}, ${record}) _postgrest_r${where}
         returning ${returning}`,
        builder.params,
        { withBody: 200, withoutBody: 204 },
      );
    }

    if (method === "POST") {
      const rows = Array.isArray(payload) ? payload : [payload];
      if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
        fail(400, "PGRST102", "An insert needs JSON objects");
      }
      const names = parsed.columns ?? [
        ...new Set(rows.flatMap((row) => Object.keys(row as object))),
      ];
      checkColumns(names);
      if (rows.length === 0) {
        return prefer.representation
          ? answerRows(request, 201, "[]", {})
          : new Response(null, { status: 201 });
      }
      const columnList = names.map(quoteIdent).join(", ");
      const recordset = builder.jsonParam(rows);
      let conflict = "";
      if (prefer.resolution) {
        const target = parsed.onConflict ?? info.primaryKey;
        if (target.length === 0) {
          fail(400, "PGRST100", `Table ${tableName} has no primary key to resolve duplicates on`);
        }
        target.forEach((name) => builder.column(name));
        const updates = names.filter((name) => !target.includes(name));
        conflict =
          prefer.resolution === "ignore" || updates.length === 0
            ? ` on conflict (${target.map(quoteIdent).join(", ")}) do nothing`
            : ` on conflict (${target.map(quoteIdent).join(", ")}) do update set ${updates
                .map((name) => `${quoteIdent(name)} = excluded.${quoteIdent(name)}`)
                .join(", ")}`;
      }
      const insert =
        names.length === 0
          ? `insert into ${builder.qualified} default values`
          : `insert into ${builder.qualified} (${columnList})
               select ${columnList} from json_populate_recordset(null::${builder.qualified}, ${recordset})`;
      return mutate(request, `${insert}${conflict} returning ${returning}`, builder.params, {
        withBody: 201,
        withoutBody: 201,
      });
    }

    fail(405, "PGRST117", `Unsupported HTTP method: ${method}`);
  };

  const handler = (async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    try {
      const rest = /^\/rest\/v1\/([^/]+)$/.exec(url.pathname);
      if (!rest) {
        return json(404, {
          code: "PGRST125",
          message: `Invalid path: ${url.pathname}`,
          details: null,
          hint: null,
        });
      }
      const tableName = decodeURIComponent(rest[1]!);
      if (!IDENTIFIER.test(tableName)) {
        fail(404, "PGRST205", `Could not find the table 'public.${tableName}' in the schema cache`);
      }
      const method = request.method.toUpperCase();
      if (method === "GET" || method === "HEAD") {
        return await read(request, tableName, url, method === "HEAD");
      }
      return await write(request, tableName, url);
    } catch (error) {
      if (error instanceof RequestError) {
        return json(error.status, error.body);
      }
      const pg = error as { code?: string; message?: string; detail?: string; hint?: string };
      if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) {
        return json(statusForPgCode(pg.code), {
          code: pg.code,
          message: pg.message ?? "Database error",
          details: pg.detail ?? null,
          hint: pg.hint ?? null,
        });
      }
      return json(500, {
        code: "PGRST000",
        message: error instanceof Error ? error.message : "Local database error",
        details: null,
        hint: null,
      });
    }
  }) as PostgrestHandler;

  handler.reloadSchema = async () => {
    schema = loadSchema();
    await schema;
  };
  return handler;
}
