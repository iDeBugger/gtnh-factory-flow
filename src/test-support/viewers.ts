import type { Viewer } from "@/lib/server/http/viewer";

/**
 * Every kind of viewer the access rules tell apart, shared by the service
 * rules' table (`access.test.ts`) and their SQL forms' (`visibility.test.ts`),
 * so both are asked about the same people.
 */
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const STRANGER = "22222222-2222-4222-8222-222222222222";

export const viewers: Record<string, Viewer> = {
  anonymous: { isAdmin: false, adminToken: false },
  owner: { userId: OWNER, username: "owner", isAdmin: false, adminToken: false },
  stranger: { userId: STRANGER, username: "stranger", isAdmin: false, adminToken: false },
  "admin account": { userId: STRANGER, username: "admin", isAdmin: true, adminToken: false },
  "admin header": { isAdmin: false, adminToken: true },
  "admin header, signed in": {
    userId: STRANGER,
    username: "stranger",
    isAdmin: false,
    adminToken: true,
  },
};
