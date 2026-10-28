import { answeringErrors } from "@/lib/server/http/error-response";
import { serviceResponse } from "@/lib/server/http/service-response";
import { readViewer } from "@/lib/server/http/viewer";
import { searchAccounts } from "@/lib/server/services/accounts";
import { isDatabaseConfigured } from "@/lib/server/services/config";

/**
 * Accounts whose username starts with `q` (any case), for picking whom to
 * share a plan with: up to 10 `{ id, username }`, the caller left out.
 */
export const GET = answeringErrors("Accounts could not be searched.", async (request: Request) => {
  if (!isDatabaseConfigured()) {
    return Response.json({ error: "Accounts are not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  const result = await searchAccounts(viewer, new URL(request.url).searchParams.get("q") ?? "");
  return serviceResponse(result, (accounts) => ({ accounts }));
});
