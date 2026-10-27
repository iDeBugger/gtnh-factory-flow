import { sameSecret } from "./secret";

/** The admin header, checked in constant time; with no token configured nobody is admin. */
export function isAdminRequest(request: Request): boolean {
  return sameSecret(request.headers.get("x-admin-token"), process.env.COMMUNITY_ADMIN_TOKEN);
}
