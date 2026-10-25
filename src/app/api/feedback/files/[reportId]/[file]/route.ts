import { NextResponse } from "next/server";
import { isCommunityConfigured } from "@/lib/server/community";
import { isFileStoreConfigured } from "@/lib/server/file-store";
import { FEEDBACK_FILE, FEEDBACK_REPORT_ID, readFeedbackFile } from "@/lib/server/feedback-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A report's picture or plan file, as its issue links to it. A stored file never changes. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string; file: string }> },
) {
  const { reportId, file } = await params;
  if (!FEEDBACK_REPORT_ID.test(reportId) || !FEEDBACK_FILE.test(file) || !isCommunityConfigured() || !isFileStoreConfigured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const bytes = await readFeedbackFile(reportId, file);
  if (!bytes) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const isPicture = file.endsWith(".png");
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": isPicture ? "image/png" : "application/json",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      ...(isPicture ? {} : { "Content-Disposition": `attachment; filename="${file}"` }),
    },
  });
}
