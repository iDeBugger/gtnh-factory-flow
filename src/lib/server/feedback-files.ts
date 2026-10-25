import { getFileStore, type FileBucket } from "./file-store";

/**
 * A report's picture and plan files, in a private file store bucket of their own and served through
 * `/api/feedback/files/<report>/<file>`, so the issue's links stay on this site.
 */
export const FEEDBACK_BUCKET: FileBucket = "feedback-files";

/** The files a report may hold: its picture and its plans by number. */
export const FEEDBACK_FILE = /^(picture\.png|plan-[1-5]\.json)$/;
export const FEEDBACK_REPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stores one of a report's files; its address on this site, or undefined when storage refused it. */
export async function storeFeedbackFile(
  origin: string,
  reportId: string,
  file: string,
  bytes: Buffer,
): Promise<string | undefined> {
  if (!FEEDBACK_REPORT_ID.test(reportId) || !FEEDBACK_FILE.test(file)) {
    return undefined;
  }
  try {
    await getFileStore().put(FEEDBACK_BUCKET, `${reportId}/${file}`, bytes, { overwrite: true });
    return `${origin}/api/feedback/files/${reportId}/${file}`;
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
    await getFileStore().remove(
      FEEDBACK_BUCKET,
      files.map((file) => `${reportId}/${file}`),
    );
  } catch {
    // The files stay; nothing links to them.
  }
}

export async function readFeedbackFile(reportId: string, file: string): Promise<Buffer | undefined> {
  try {
    return await getFileStore().get(FEEDBACK_BUCKET, `${reportId}/${file}`);
  } catch {
    return undefined;
  }
}
