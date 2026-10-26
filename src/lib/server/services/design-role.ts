import * as designMembers from "../repos/design-members";

/**
 * Who may do what with a design, for the site's library and the live service
 * alike. It loads one repository and nothing else, so the live service takes
 * the rule without the library's saves, rate limits or notices.
 */

export type DesignRole = "owner" | "editor";

/**
 * What `userId` may do with the design: "owner", "editor" (a member), or
 * null (nothing, or no such design). Throws when the database does not answer.
 */
export async function designRole(
  userId: string,
  ownerId: string,
  designId: string,
): Promise<DesignRole | null> {
  if (userId === ownerId) {
    return "owner";
  }
  return (await designMembers.isMember(userId, ownerId, designId)) ? "editor" : null;
}
