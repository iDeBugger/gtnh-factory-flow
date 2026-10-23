import { z } from "zod";
import {
  factoryAnnotationSchema,
  factoryEdgeSchema,
  factoryNodeSchema,
  factoryPocketSchema,
  factoryProjectSchema,
  factoryStorageSchema,
  fuelProfileSchema,
  planTaskCommentSchema,
  planTaskItemSchema,
  planTaskSchema,
  productionGroupSchema,
  recipeSchema,
} from "@/lib/model/schemas";
import {
  jsonEqual,
  type LiveCollection,
  type LiveOp,
  type LiveThing,
  LIVE_COLLECTIONS,
} from "./ops";

/**
 * What a live batch may leave behind: every thing it put or patched must
 * pass its collection's schema afterwards, and every plan field it set or
 * deleted must pass the plan schema's rule for that field (a required field
 * cannot be deleted, an unknown one cannot be set). Checked by the live
 * service on what the batch would leave (`src/live/doc.ts` stages it); a
 * batch that fails is refused whole.
 *
 * What is stored is the schema's output, as a REST save stores it: fields a
 * thing's schema does not know are dropped and values it normalises are
 * normalised. When that differs from what the batch left, the check answers
 * the op that makes it so (`fix`), which the service appends to the batch, so
 * every client lands on what is stored.
 *
 * A thing only patched is checked field by field: its other fields passed
 * when they were written, and a plain object schema is its fields. A thing
 * put in the batch, or one whose schema checks the object as a whole, is
 * checked whole. Either way the cost is what the batch touched.
 */

export const LIVE_ENTITY_SCHEMAS: Record<LiveCollection, z.ZodType> = {
  recipes: recipeSchema,
  nodes: factoryNodeSchema,
  storages: factoryStorageSchema,
  edges: factoryEdgeSchema,
  annotations: factoryAnnotationSchema,
  pockets: factoryPocketSchema,
  fuelProfiles: fuelProfileSchema,
  productionGroups: productionGroupSchema,
  tasks: planTaskSchema,
  taskItems: planTaskItemSchema,
  taskComments: planTaskCommentSchema,
};

// Every collection is listed above; this fails to compile when one is added
// to LIVE_COLLECTIONS without a schema.
void (LIVE_COLLECTIONS satisfies readonly (keyof typeof LIVE_ENTITY_SCHEMAS)[]);

const META_SCHEMAS = factoryProjectSchema.shape as unknown as Record<string, z.ZodType>;

/**
 * Plan fields no live edit may set or delete. The game version picks which
 * recipes and machine rules the plan is read with, so it changes only by
 * converting the plan into a new design; clients leave it out of live edits
 * (`live-shape.ts`), and the service refuses a batch that names it.
 */
const NEVER_LIVE_FIELDS: ReadonlySet<string> = new Set(["gameVersion"]);

/** A schema's fields, when it is a plain object schema (no whole-object checks, unknown keys dropped). */
function fieldSchemas(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  if (!(schema instanceof z.ZodObject)) {
    return undefined;
  }
  const def = schema._zod.def as { checks?: unknown[]; catchall?: unknown };
  if ((def.checks?.length ?? 0) > 0 || def.catchall !== undefined) {
    return undefined;
  }
  return schema.shape as Record<string, z.ZodType>;
}

const FIELD_SCHEMAS = new Map<LiveCollection, Record<string, z.ZodType> | undefined>(
  LIVE_COLLECTIONS.map((c) => [c, fieldSchemas(LIVE_ENTITY_SCHEMAS[c])]),
);

function describeIssue(error: z.ZodError, prefix: string[] = []): string {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid";
  }
  const path = [...prefix, ...issue.path.map(String)];
  return `${path.length > 0 ? `${path.join(".")}: ` : ""}${issue.message}`;
}

function own<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

function hasValue(thing: Record<string, unknown>, name: string): boolean {
  return own(thing, name) !== undefined;
}

/** One thing as a batch would leave it. */
export interface ThingToCheck {
  c: LiveCollection;
  id: string;
  /** Undefined when the batch deleted it: nothing to check. */
  after: Record<string, unknown> | undefined;
  /** Put in the batch: checked whole. */
  replaced: boolean;
  /** The fields the batch's patches named, for a thing only patched. */
  fields: ReadonlySet<string>;
}

export type CheckResult = { error: string } | { fix?: LiveOp };

/**
 * Whether a thing as the batch leaves it may be stored, and the op that turns
 * it into the schema's output when that differs (a put when checked whole, a
 * patch of the named fields otherwise).
 */
export function checkThing(thing: ThingToCheck): CheckResult {
  const { c, id, after } = thing;
  if (!after) {
    return {};
  }
  const fields = thing.replaced ? undefined : FIELD_SCHEMAS.get(c);
  if (!fields) {
    const result = LIVE_ENTITY_SCHEMAS[c].safeParse(after);
    if (!result.success) {
      return { error: `${c} ${id}: ${describeIssue(result.error)}` };
    }
    const stored = { ...(result.data as Record<string, unknown>), id } as LiveThing;
    return jsonEqual(stored, after) ? {} : { fix: { o: "put", c, id, v: stored } };
  }
  const f: Record<string, unknown> = {};
  const d: string[] = [];
  for (const name of thing.fields) {
    if (name === "id") {
      continue;
    }
    const schema = own(fields, name);
    const present = hasValue(after, name);
    if (!schema) {
      // A field the schema does not know: dropped, as a REST save drops it.
      if (present) {
        d.push(name);
      }
      continue;
    }
    const result = schema.safeParse(present ? after[name] : undefined);
    if (!result.success) {
      return { error: `${c} ${id}: ${describeIssue(result.error, [name])}` };
    }
    if (present && !jsonEqual(result.data, after[name])) {
      if (result.data === undefined) {
        d.push(name);
      } else {
        f[name] = result.data;
      }
    }
  }
  if (d.length === 0 && Object.keys(f).length === 0) {
    return {};
  }
  return { fix: d.length > 0 ? { o: "patch", c, id, f, d } : { o: "patch", c, id, f } };
}

/**
 * Whether a plan field may hold `value` (undefined: deleted), and the value
 * the schema stores when it differs. Collections are never plan fields.
 */
export function checkPlanField(
  name: string,
  value: unknown,
): { error: string } | { fix?: { value: unknown } } {
  if (NEVER_LIVE_FIELDS.has(name)) {
    return { error: `plan field ${name}: not a live edit` };
  }
  const schema = own(META_SCHEMAS, name);
  if (!schema || (LIVE_COLLECTIONS as readonly string[]).includes(name)) {
    return { error: `plan field ${JSON.stringify(name.slice(0, 40))} is not part of a plan` };
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return { error: `plan field ${name}: ${describeIssue(result.error)}` };
  }
  if (value !== undefined && !jsonEqual(result.data, value)) {
    return { fix: { value: result.data } };
  }
  return {};
}
