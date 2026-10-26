import { NextResponse } from "next/server";
import { serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { serviceResponse } from "@/lib/server/http/service-response";
import { readViewer } from "@/lib/server/http/viewer";
import { downloadBlueprint } from "@/lib/server/services/blueprints";
import { isDatabaseConfigured } from "@/lib/server/services/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A public blueprint's payload for placing, counting the download (`downloadBlueprint`). */
export async function POST(
  request: Request,
  context: { params: Promise<{ blueprintId: string }> },
) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }

  try {
    const { blueprintId } = await context.params;
    const viewer = await readViewer(request);
    return serviceResponse(await downloadBlueprint(viewer, blueprintId), (value) => value, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return serverErrorResponse(error, "Downloading the blueprint failed.");
  }
}
