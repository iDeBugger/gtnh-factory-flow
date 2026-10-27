import type { LookupFunction } from "node:net";

export type Mode = "off" | "on";

/** A value kept from an answer for later cases: a JSON path (dots, a negative index counts from the end), a header, or a cookie. */
export type Save =
  | { from: "json"; path: string; as: string; pathOnly?: true }
  | { from: "header"; name: string; as: string }
  | { from: "cookie"; name: string; as: string };

export interface Case {
  name: string;
  method: string;
  /** Sent byte for byte after `{name}` substitution. */
  target: string;
  /** The route file's Next path (`/api/blueprints/[blueprintId]`), for cases generated from the route table. */
  route?: string;
  /** Case headers override the capture's defaults by name; a null value removes a default. */
  headers?: Record<string, string | null>;
  body?: string | Buffer | ((vars: Map<string, unknown>) => string | Buffer);
  /** The body's size, for the body-cap cases. */
  bodyBytes?: number;
  /** Send the body with Transfer-Encoding: chunked. */
  chunked?: true;
  /** A reset before the whole answer was read fails the case. */
  strict?: true;
  /** Saved values the body needs; the case is recorded as skipped without them. */
  needs?: string[];
  save?: Save[];
  modes: Mode[];
  nextOnly?: true;
  localOnly?: true;
}

export type Step = Case;

export declare const VERSIONS: string[];
export declare const ROUTE_TABLE: { route: string; path: string; methods: string[] }[];
export declare const CASES: Case[];
export declare const SCENARIO: Step[];

export interface RawRequest {
  base: string;
  method?: string;
  target: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | Buffer;
  chunks?: (string | Buffer)[];
  chunkDelayMs?: number;
  timeoutMs?: number;
  strict?: boolean;
  ca?: string | Buffer;
  lookup?: LookupFunction;
}

export interface RawAnswer {
  status: number;
  /** Every header in order, names in lower case, duplicates kept. */
  headers: [string, string][];
  body: Buffer;
  bytesSent: number;
  socketClosedEarly: boolean;
}
