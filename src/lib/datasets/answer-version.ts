import { APP_VERSION } from "@/lib/version";

/**
 * The identity of the code behind dataset API answers, sent with every dataset
 * request beside `datasetHash`.
 *
 * A dataset answer is the dataset's bytes run through the server's code
 * (ranking, spelling correction, merged catalog fields, hydrated summaries), so
 * the dataset hash alone does not pin it: a deploy that changes how a search
 * ranks would otherwise be served stale, for a year, to every browser and edge
 * cache holding the old URL. The token is the build, not the release number:
 * several builds can ship under one APP_VERSION (work folded into an unshipped
 * bump, a redeploy). `next.config.ts` bakes `NEXT_PUBLIC_GTNH_BUILD_ID`
 * (`<version>-<sha8>`) into the server and browser bundles alike, so both read
 * the same value. The server marks an answer immutable only when the request
 * carries this exact token (`datasetCacheHeaders`), so a URL from a tab opened
 * before a deploy is never cached under the new code's answer.
 */
export function answerVersionToken(appVersion: string, buildId: string | undefined): string {
  const build = buildId?.trim();
  return build ? build : appVersion;
}

export const DATASET_ANSWER_VERSION = answerVersionToken(
  APP_VERSION,
  process.env.NEXT_PUBLIC_GTNH_BUILD_ID,
);
export const DATASET_ANSWER_VERSION_PARAM = "appVersion";
