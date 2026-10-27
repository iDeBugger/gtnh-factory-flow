import { serverErrorResponse } from "@/lib/server/http/error-response";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { modAndCommunityOffResponse } from "@/lib/server/http/mod-and-community-gate";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { downloadPlan } from "@/lib/server/services/community-plans";
import { readViewer } from "@/lib/server/http/viewer";
import { serviceResponse } from "@/lib/server/http/service-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Returns the full plan JSON and counts the download. */
export async function POST(request: Request, { params }: { params: Promise<{ planId: string }> }) {
  if (!isModAndCommunityOn()) {
    return modAndCommunityOffResponse();
  }
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Community hub is not configured." }, { status: 503 });
  }

  try {
    const { planId } = await params;
    const viewer = await readViewer(request);
    const result = await downloadPlan(viewer, planId);
    return serviceResponse(result, (value) => ({ name: value.name, plan: value.plan }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return serverErrorResponse(error, "Downloading the plan failed.");
  }
}
