import {
  DATASET_ANSWER_VERSION,
  DATASET_ANSWER_VERSION_PARAM,
} from "@/lib/datasets/answer-version";

/**
 * Cache policy for dataset API responses.
 *
 * Every dataset request the app makes carries two cache keys: `datasetHash`
 * (the version's content checksum) and the answer version (the code that
 * turned those bytes into the answer, `answer-version.ts`). With both, a URL
 * can never mean different bytes and the response is safe to cache
 * indefinitely, in the browser and at a CDN. A request missing either, or
 * carrying another release's answer version, gets no-store: its URL could be
 * reused by code that answers differently.
 */
export function datasetCacheHeaders(request: Request): Record<string, string> {
  // In dev the server code behind these responses changes constantly, and an
  // immutable cache would keep serving stale output. Production only.
  if (process.env.NODE_ENV !== "production") {
    return { "Cache-Control": "no-store" };
  }
  const params = new URL(request.url).searchParams;
  const fingerprinted =
    params.has("datasetHash") &&
    params.get(DATASET_ANSWER_VERSION_PARAM) === DATASET_ANSWER_VERSION;
  return {
    "Cache-Control": fingerprinted ? "public, max-age=31536000, immutable" : "no-store",
  };
}
