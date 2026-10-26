import { sql, type RawBuilder } from "kysely";

/**
 * How values come out of Postgres and how jsonb goes in, the same on `pg` and
 * on PGlite: both hand these parsers Postgres's text form, so one table serves
 * the pool, the tests' PGlite and the local database.
 *
 * The answers keep the spelling PostgREST gave (its `to_json` form), so a
 * route's JSON does not change when its query moves off PostgREST
 * (`app/api/wire-format.test.ts`).
 */

const UTC_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)\+00$/;

/**
 * A `timestamptz` as JSON spells it: `2026-10-25 17:33:50.431+00` becomes
 * `2026-10-25T17:33:50.431+00:00`, fraction digits as Postgres printed them.
 * Every session runs in UTC (`dbSettings`, `openLocalDatabase`), so any other
 * offset means a session that skipped that setting: it throws rather than
 * answer a time a client would read in the wrong zone.
 */
export function toJsonTimestamp(text: string): string {
  const match = UTC_TIMESTAMP.exec(text);
  if (!match) {
    throw new Error(`Not a UTC timestamp: ${text} (the database session must run in UTC)`);
  }
  return `${match[1]}T${match[2]}+00:00`;
}

/**
 * OID to parser: `timestamptz` (1184) as JSON text, `bigint` (20) as a number,
 * as PostgREST answered both. Scalars only: an array of either (`timestamptz[]`
 * 1185, `bigint[]` 1016, as `array_agg` returns) reads differently on the two
 * drivers until its own OID is added here.
 */
export const DB_TYPE_PARSERS: Record<number, (text: string) => unknown> = {
  1184: toJsonTimestamp,
  20: Number,
};

declare const jsonParamBrand: unique symbol;

/**
 * What a jsonb column takes on insert and update. Only `json()` makes one: `pg`
 * sends a JS array parameter as a Postgres array, so a raw `needs: [...]`
 * would fail or store the wrong value, and the type makes it a compile error.
 */
export type JsonParam = { readonly [jsonParamBrand]: true };

/** A value for a jsonb column: its JSON text as one bound parameter, cast to jsonb. */
export function json(value: unknown): RawBuilder<JsonParam> {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError("json() takes a JSON value, not undefined or a function");
  }
  return sql<JsonParam>`cast(${text} as jsonb)`;
}
