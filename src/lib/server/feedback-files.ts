import { getCommunityDb } from "./community";

/**
 * A report's picture and plan files, in a private bucket of their own and served through
 * `/api/feedback/files/<report>/<file>`, so the issue's links stay on this site.
 */
export const FEEDBACK_BUCKET = "feedback-files";
const FILE_MAX_BYTES = 5 * 1024 * 1024;

/** The files a report may hold: its picture and its plans by number. */
export const FEEDBACK_FILE = /^(picture\.png|plan-[1-5]\.json)$/;
export const FEEDBACK_REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let bucketReady = false;

async function ensureBucket(): Promise<void> {
  if (bucketReady) {
    return;
  }
  const db = getCommunityDb();
  const { data } = await db.storage.getBucket(FEEDBACK_BUCKET);
  if (!data) {
    const { error } = await db.storage.createBucket(FEEDBACK_BUCKET, {
      public: false,
      fileSizeLimit: FILE_MAX_BYTES,
    });
    if (error && !/already exists/i.test(error.message)) {
      throw new Error(`Feedback storage bucket could not be created: ${error.message}`);
    }
  }
  bucketReady = true;
}

/** Stores one of a report's files; its address on this site, or undefined when storage refused it. */
export async function storeFeedbackFile(
  origin: string,
  reportId: string,
  file: string,
  bytes: Buffer,
  contentType: string,
): Promise<string | undefined> {
  try {
    await ensureBucket();
    const { error } = await getCommunityDb()
      .storage.from(FEEDBACK_BUCKET)
      .upload(`${reportId}/${file}`, bytes, { contentType, upsert: true });
    return error ? undefined : `${origin}/api/feedback/files/${reportId}/${file}`;
  } catch {
    return undefined;
  }
}

/**
 * Removes a report's stored files once the issue they were for could not be
 * opened: a file nobody links to is only a copy of someone's plan kept for
 * nothing. Best effort, never throws.
 */
export async function removeFeedbackFiles(reportId: string, files: string[]): Promise<void> {
  if (files.length === 0) {
    return;
  }
  try {
    await getCommunityDb()
      .storage.from(FEEDBACK_BUCKET)
      .remove(files.map((file) => `${reportId}/${file}`));
  } catch {
    // The files stay; nothing links to them.
  }
}

export async function readFeedbackFile(reportId: string, file: string): Promise<Buffer | undefined> {
  try {
    const { data, error } = await getCommunityDb()
      .storage.from(FEEDBACK_BUCKET)
      .download(`${reportId}/${file}`);
    if (error || !data) {
      return undefined;
    }
    return Buffer.from(await data.arrayBuffer());
  } catch {
    return undefined;
  }
}
