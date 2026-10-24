import { APP_VERSION } from "@/lib/version";

/**
 * The version of the code behind dataset API answers, sent with every dataset
 * request beside `datasetHash`.
 *
 * A dataset answer is the dataset's bytes run through the server's code
 * (ranking, spelling correction, merged catalog fields, hydrated summaries), so
 * the dataset hash alone does not pin it: a deploy that changes how a search
 * ranks would otherwise be served stale, for a year, to every browser and edge
 * cache holding the old URL. The release version is the token because every
 * deploy gets its own. The server marks an answer immutable only when the
 * request carries this exact token (`datasetCacheHeaders`), so a URL from a tab
 * opened before a deploy is never cached under the new code's answer.
 */
export const DATASET_ANSWER_VERSION = APP_VERSION;
export const DATASET_ANSWER_VERSION_PARAM = "appVersion";
