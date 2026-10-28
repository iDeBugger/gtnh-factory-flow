import { create } from "zustand";
import type { LibraryListResponse, PlanMember, RemoteDesignMeta, SharedDesign } from "./sync-types";

/**
 * The sharing side of the account library: plans others shared with this
 * account, who each of ours is shared with, and the REST calls that change
 * it. The account sync fills the lists on every run (it already asks for
 * them); the Share dialog and the Library read them.
 */

export interface CloudLibraryState {
  /** Plans shared with this account, as the last sync heard (undefined: not heard yet). */
  shared?: SharedDesign[];
  /** Who each of our own designs is shared with, by design id. */
  members: Record<string, PlanMember[]>;
}

export const useCloudLibraryStore = create<CloudLibraryState>(() => ({
  shared: undefined,
  members: {},
}));

/** The account library as a sync run read it. */
export function noteRemoteLibrary(response: LibraryListResponse): void {
  const members: Record<string, PlanMember[]> = {};
  for (const design of response.designs) {
    if (design.members && design.members.length > 0 && !design.deletedAt) {
      members[design.id] = design.members;
    }
  }
  useCloudLibraryStore.setState({
    members,
    ...(Array.isArray(response.shared) ? { shared: response.shared } : {}),
  });
}

/** Signed out: nothing is shared with nobody. */
export function forgetRemoteLibrary(): void {
  useCloudLibraryStore.setState({ shared: undefined, members: {} });
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as
    | (T & { error?: string })
    | undefined;
  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return body;
}

function designUrl(designId: string, ownerId?: string, rest = ""): string {
  const owner = ownerId ? `?owner=${encodeURIComponent(ownerId)}` : "";
  return `/api/library/designs/${encodeURIComponent(designId)}${rest}${owner}`;
}

export interface SharedPlanRead {
  design: RemoteDesignMeta;
  plan: unknown;
  ownerId: string;
  role: "owner" | "editor";
  seq: number;
  live: boolean;
}

/** A plan shared with this account, read whole. */
export async function fetchSharedPlan(ownerId: string, designId: string): Promise<SharedPlanRead> {
  return readJson<SharedPlanRead>(await fetch(designUrl(designId, ownerId), { cache: "no-store" }));
}

export interface PlanMembers {
  ownerId: string;
  ownerName: string;
  role: "owner" | "editor";
  members: PlanMember[];
}

export async function fetchPlanMembers(designId: string, ownerId?: string): Promise<PlanMembers> {
  return readJson<PlanMembers>(
    await fetch(designUrl(designId, ownerId, "/members"), { cache: "no-store" }),
  );
}

/** Shares one of our designs with an account (owner only). Answers the members after. */
export async function addPlanMember(designId: string, userId: string): Promise<PlanMember[]> {
  const body = await readJson<{ members: PlanMember[] }>(
    await fetch(designUrl(designId, undefined, `/members/${encodeURIComponent(userId)}`), {
      method: "PUT",
    }),
  );
  rememberMembers(designId, body.members);
  return body.members;
}

/** The owner unshares, or a member leaves (`userId` their own, `ownerId` the plan's). */
export async function removePlanMember(
  designId: string,
  userId: string,
  ownerId?: string,
): Promise<PlanMember[]> {
  const body = await readJson<{ members: PlanMember[] }>(
    await fetch(designUrl(designId, ownerId, `/members/${encodeURIComponent(userId)}`), {
      method: "DELETE",
    }),
  );
  if (!ownerId) {
    rememberMembers(designId, body.members);
  }
  return body.members;
}

function rememberMembers(designId: string, members: PlanMember[]): void {
  useCloudLibraryStore.setState((state) => {
    const next = { ...state.members };
    if (members.length > 0) {
      next[designId] = members;
    } else {
      delete next[designId];
    }
    return { members: next };
  });
}

/** Accounts whose name starts with `query`, you left out. */
export async function searchAccounts(query: string, signal?: AbortSignal): Promise<PlanMember[]> {
  const response = await fetch(`/api/accounts/search?q=${encodeURIComponent(query)}`, {
    cache: "no-store",
    signal,
  });
  return (await readJson<{ accounts: PlanMember[] }>(response)).accounts;
}
