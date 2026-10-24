"use client";

import {
  downloadCommunityPlan,
  getCommunityPlan,
  tagPlanWithCommunityId,
  untagCommunityPlan,
} from "@/lib/community/client";
import { parseFactoryProjectJson } from "@/lib/import-export";
import { applyPlanView } from "@/lib/plan-view";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";

/**
 * The one way a community post opens, from anywhere (a tile, a menu, the
 * Welcome page, a pasted link). A post is like an uploaded file: opening it
 * makes a plan of your own, and nothing syncs between the two.
 *
 * - YOUR post opens as your design. If the design is in this library, it
 *   opens; if it is not (another browser, no account sync), it comes down as
 *   that design, linked, so Share can update the post.
 * - Someone else's post opens as a COPY: a new design with no link to the
 *   post. There is no view-only mode.
 *
 * `isMine` is read from the summary when the caller has one; a bare id
 * (a pasted link) asks the server first.
 */
export async function openCommunityPost(plan: {
  id: string;
  name?: string;
  isMine?: boolean;
  authorName?: string;
}): Promise<"opened" | "copied"> {
  const store = useDesignStore.getState();
  const existing = store.designs.find((design) => design.communityPlanId === plan.id);
  let isMine = plan.isMine;
  let name = plan.name;
  if (isMine === undefined) {
    // A lookup: the download below is what this counts as, not a view.
    const summary = await getCommunityPlan(plan.id);
    isMine = summary.isMine === true;
    name = name ?? summary.name;
  }

  if (existing && isMine) {
    await store.switchToDesign(existing.id);
    return "opened";
  }

  const { plan: planJson, name: postName } = await downloadCommunityPlan(plan.id);
  const tagged = isMine ? tagPlanWithCommunityId(planJson, plan.id) : untagCommunityPlan(planJson);
  const project = parseFactoryProjectJson(JSON.stringify(tagged));
  // The post's name first: it is the one on the tile just clicked.
  await useDesignStore.getState().importProjectAsDesign(project, name || postName || project.name);
  applyPlanView(project.view);
  return isMine ? "opened" : "copied";
}

/** Copy directly from the library, without first opening a viewing session. */
export async function copyCommunityPost(post: { id: string; name?: string }): Promise<void> {
  const { plan, name } = await downloadCommunityPlan(post.id);
  const project = parseFactoryProjectJson(JSON.stringify(untagCommunityPlan(plan)));
  await useDesignStore.getState().importProjectAsDesign(project, post.name || name || project.name);
  applyPlanView(project.view);
}

/** A snapshot of the viewed post becomes a private, editable personal design. */
export async function copyViewedPost(): Promise<void> {
  const store = useDesignStore.getState();
  const view = store.publicView;
  if (!view) return;
  const project = parseFactoryProjectJson(
    JSON.stringify(untagCommunityPlan(useFactoryStore.getState().project)),
  );
  await store.importProjectAsDesign(project, view.name);
}
