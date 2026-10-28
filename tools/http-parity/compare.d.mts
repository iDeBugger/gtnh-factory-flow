/** A case as capture.mjs stores it, after normalize.mjs. */
export interface StoredCase {
  name: string;
  request: { method: string; target: string; route?: string };
  status: number;
  headers: [string, string][];
  body?: { text?: string; sha256?: string; length?: number; bytes?: number; pixels?: string };
}

export interface AllowEntry {
  case: string;
  field: string;
  reason: string;
  status?: number;
  a?: string;
  b?: string;
  transform?: string;
  keep?: string[];
}

export interface Difference {
  field: string;
  a?: unknown;
  b?: unknown;
}

export declare const IGNORED_HEADERS: Set<string>;
export declare function diffCases(
  a: StoredCase | undefined,
  b: StoredCase | undefined,
  allow?: AllowEntry[],
): Difference[];
export declare function readCaptureDir(dir: string): Map<string, StoredCase>;
