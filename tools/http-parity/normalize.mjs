/**
 * Turns one raw answer into what two servers can be compared on.
 *
 * Only values that differ between two runs of the same server are replaced,
 * and each by a token that keeps the shape of the answer:
 * - UUIDs by `<uuid:n>` and session cookie values by `<cookie:n>`, numbered by
 *   first appearance in the run, so the same id in two answers stays the
 *   same token, and two runs that make the same rows in the same order
 *   compare equal;
 * - ISO and HTTP-date timestamps by `<time>`;
 * - a board image's random name by `<image:n>`, and its month by `<month>`;
 * - a `Retry-After` count of seconds by `<seconds>`;
 * - each asset URL (`/_next/static/...`, `/assets/...`) by `<asset:sha256-8>`
 *   of the bytes it serves, so one file under two build names compares equal
 *   and two different files do not;
 * - an ETag of a body that held any of these, since it hashes the volatile
 *   bytes.
 *
 * Dataset answers are never touched: they must match byte for byte. The one
 * exception is the prewarm answer's own stopwatch.
 */
import { createHash } from "node:crypto";
import { PNG } from "pngjs";

export const TEXT_LIMIT = 256 * 1024;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const HTTP_DATE =
  /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT/g;
const SESSION_COOKIE = /gtnh_session=([^;\s",]+)/g;
const BOARD_IMAGE = /\/api\/community\/images\/\d{4}-\d{2}\/([0-9a-f]{18})\.(png|jpg|gif|webp)/g;
/** An asset URL as it appears in HTML, in the RSC flight (JSON-escaped) and in a `Link` header. */
const ASSET_URL = /\/(?:_next\/static|assets)\/[^"'\s<>\\)`]+/g;
// Case-sensitive, as the routes are: `/DATASETS/...` is a 404 page, not a dataset answer.
const DATASET_PATH = /^\/(?:api\/datasets|datasets|dataset-files)\//;
const CLIENT_FILE_PATH = /^\/datasets\/gtnh\/[^/]+\/client\//;
const PREWARM_PATH = /^\/api\/datasets\/[^/]+\/prewarm(?:\?|$)/;
const TEXT_TYPE = /json|^text\/|xml|javascript|html|manifest|svg/i;

export function createNormalizeState() {
  return { uuids: new Map(), cookies: new Map(), images: new Map() };
}

function numbered(map, value, label) {
  if (!map.has(value)) map.set(value, map.size + 1);
  return `<${label}:${map.get(value)}>`;
}

/** The run-volatile values in a text, replaced by stable tokens. */
export function normalizeText(text, state) {
  return text
    .replace(
      BOARD_IMAGE,
      (_match, name, ext) =>
        `/api/community/images/<month>/${numbered(state.images, name, "image")}.${ext}`,
    )
    .replace(UUID, (uuid) => numbered(state.uuids, uuid.toLowerCase(), "uuid"))
    .replace(
      SESSION_COOKIE,
      (match, value) => `gtnh_session=${numbered(state.cookies, value, "cookie")}`,
    )
    .replace(ISO_TIME, "<time>")
    .replace(HTTP_DATE, "<time>");
}

/** Every asset URL a text names, once each, in order. */
export function assetUrls(text) {
  return [...new Set(text.match(ASSET_URL) ?? [])];
}

/** Asset URLs replaced by `<asset:...>` of their bytes' hash; a URL the capture could not fetch keeps its name. */
export function replaceAssets(text, assetHashes) {
  return text.replace(ASSET_URL, (url) => {
    const hash = assetHashes?.get(url);
    return hash ? `<asset:${hash.slice(0, 8)}>` : url;
  });
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isDatasetTarget(target) {
  return DATASET_PATH.test(target);
}

function headerValue(headers, name) {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

function isText(headers, body) {
  const type = headerValue(headers, "content-type");
  if (type) return TEXT_TYPE.test(type);
  if (body.length === 0) return true;
  const text = body.toString("utf8");
  return !text.includes("�") && !text.includes("\u0000");
}

function isPng(body) {
  return (
    body.length > 8 && body[0] === 0x89 && body[1] === 0x50 && body[2] === 0x4e && body[3] === 0x47
  );
}

function pixelHash(body) {
  try {
    const png = PNG.sync.read(body);
    return sha256(Buffer.concat([Buffer.from(`${png.width}x${png.height}:`), png.data]));
  } catch {
    return undefined;
  }
}

/**
 * The stored form of one exchange: `{ name, request, status, headers, body }`.
 * `raw` is a RawAnswer (status, headers in order, body bytes).
 */
export function normalizeCase(
  raw,
  { name, request, state, assetHashes, target = request?.target ?? "" },
) {
  // A dataset answer is never HTML: a page under a dataset path is the 404 page, normalized like any page.
  const dataset =
    isDatasetTarget(target) && !/text\/html/i.test(headerValue(raw.headers, "content-type") ?? "");
  const prewarm = PREWARM_PATH.test(target);
  let bodyChanged = false;

  let body;
  const decoded =
    isText(raw.headers, raw.body) && raw.body.length <= TEXT_LIMIT
      ? raw.body.toString("utf8")
      : undefined;
  // Text only when it decodes back to the same bytes: two different invalid sequences would both read as U+FFFD.
  if (decoded !== undefined && Buffer.from(decoded, "utf8").equals(raw.body)) {
    const original = decoded;
    let text = original;
    if (prewarm) {
      text = text.replace(/"durationMs":\d+/g, '"durationMs":"<ms>"');
    } else if (!dataset) {
      text = replaceAssets(normalizeText(text, state), assetHashes);
    }
    bodyChanged = text !== original;
    body = { text };
  } else {
    body = { sha256: sha256(raw.body), length: raw.body.length };
    if (isPng(raw.body)) {
      const pixels = pixelHash(raw.body);
      if (pixels) body.pixels = pixels;
    }
  }

  const headers = raw.headers.map(([key, value]) => {
    const lower = key.toLowerCase();
    // A count of seconds varies with the clock; any other form (a date, a fraction) is a change of form and stays.
    if (lower === "retry-after") return [lower, /^\d+$/.test(value) ? "<seconds>" : value];
    if (lower === "location" || lower === "refresh" || lower === "set-cookie") {
      return [lower, normalizeText(value, state)];
    }
    if (lower === "link") return [lower, replaceAssets(value, assetHashes)];
    if (lower === "etag" && bodyChanged && !dataset) return [lower, "<etag>"];
    if (lower === "last-modified" && CLIENT_FILE_PATH.test(target)) return [lower, "<time>"];
    return [lower, value];
  });

  return { name, request: request ?? null, status: raw.status, headers, body };
}
