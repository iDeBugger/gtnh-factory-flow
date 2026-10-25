import { isAdminRequest } from "../auth/admin";
import { getSessionUser } from "../auth/sessions";

/**
 * Who is asking: the signed-in account, if any, and the two ways to be the
 * site admin. `isAdmin` is the account's flag; `adminToken` is the admin
 * header (`isAdminRequest`). The services decide what each may see.
 */
export interface Viewer {
  userId?: string;
  username?: string;
  isAdmin: boolean;
  adminToken: boolean;
}

/** The request's viewer. A failed account lookup throws, as `getSessionUser` does: never read as signed out. */
export async function readViewer(request: Request): Promise<Viewer> {
  const user = await getSessionUser(request);
  const adminToken = isAdminRequest(request);
  if (!user) {
    return { isAdmin: false, adminToken };
  }
  return { userId: user.id, username: user.username, isAdmin: user.is_admin, adminToken };
}
