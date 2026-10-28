import type { SharedPlanRef } from "@/lib/designs/design-library";
import { parseFactoryProjectJson } from "@/lib/import-export";
import { useDesignStore } from "@/store/design-store";
import { fetchSharedPlan } from "./cloud-library";

/**
 * Opens a plan someone shared with this account: this device's copy when it
 * has one, else the account's plan read whole into a new copy. The copy goes
 * live at once (live-session.ts). Throws with the reason when it cannot.
 */
export async function openSharedPlan(ref: SharedPlanRef, name: string): Promise<void> {
  const store = useDesignStore.getState();
  const hasCopy = store.designs.some(
    (design) => design.cloud?.ownerId === ref.ownerId && design.cloud.designId === ref.designId,
  );
  if (hasCopy) {
    await store.openSharedDesign(ref, name);
    return;
  }
  const read = await fetchSharedPlan(ref.ownerId, ref.designId);
  const project = parseFactoryProjectJson(JSON.stringify(read.plan));
  await store.openSharedDesign(ref, name, project);
}
