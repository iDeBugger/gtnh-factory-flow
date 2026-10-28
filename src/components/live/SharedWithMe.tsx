import { useEffect, useMemo, useState } from "react";
import { formatRelativeDate } from "@/components/shelf-cards";
import { LibraryTile } from "@/components/library/LibraryTile";
import { LibraryMenu, MenuItem } from "@/components/library/library-menu";
import { openSharedPlan } from "@/lib/library/open-shared";
import {
  removePlanMember,
  useCloudLibraryStore,
} from "@/lib/library/cloud-library";
import { syncLibraryNow } from "@/lib/library/library-sync";
import type { SharedDesign } from "@/lib/library/sync-types";
import { colorFor } from "@/lib/live/protocol";
import { useDesignStore } from "@/store/design-store";
import { noteLeavingPlan, useLiveSession } from "@/store/live-session";
import { Face } from "./LiveFaces";

/**
 * The Library's "Shared with me": plans other accounts shared with this one,
 * each with its owner and the faces of everyone in it. Opening one puts this
 * device's copy on the board (made from the account's plan the first time),
 * and the copy goes live at once: the same plan everyone in it is editing.
 */
export function SharedWithMe() {
  const shared = useCloudLibraryStore((state) => state.shared);
  const designs = useDesignStore((state) => state.designs);
  const removeDesign = useDesignStore((state) => state.removeDesign);
  const me = useLiveSession((state) => state.me);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<{ key: string; left: number; top: number }>();

  // The list comes with every account sync; ask for one now rather than wait.
  useEffect(() => {
    void syncLibraryNow();
  }, []);

  const copies = useMemo(() => {
    const byKey = new Map<string, (typeof designs)[number]>();
    for (const design of designs) {
      if (design.cloud) {
        byKey.set(`${design.cloud.ownerId}:${design.cloud.designId}`, design);
      }
    }
    return byKey;
  }, [designs]);

  const keyOf = (plan: SharedDesign) => `${plan.ownerId}:${plan.id}`;

  const open = async (plan: SharedDesign) => {
    const ref = { ownerId: plan.ownerId, ownerName: plan.ownerName, designId: plan.id };
    setBusy(keyOf(plan));
    setError(undefined);
    try {
      await openSharedPlan(ref, plan.name);
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "The plan could not be opened.");
    } finally {
      setBusy(undefined);
    }
  };

  const leave = async (plan: SharedDesign) => {
    if (!me) {
      return;
    }
    setBusy(keyOf(plan));
    setError(undefined);
    try {
      noteLeavingPlan(plan.ownerId, plan.id);
      await removePlanMember(plan.id, me.id, plan.ownerId);
      const copy = copies.get(keyOf(plan));
      if (copy) {
        await removeDesign(copy.id, { fromSync: true });
      }
      useCloudLibraryStore.setState((state) => ({
        shared: state.shared?.filter((entry) => keyOf(entry) !== keyOf(plan)),
      }));
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Could not leave the plan.");
    } finally {
      setBusy(undefined);
    }
  };

  const menuPlan = menu ? shared?.find((plan) => keyOf(plan) === menu.key) : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 compact:px-2" data-shared-with-me>
      {error ? <p className="mb-2 text-[11px] text-red-400">{error}</p> : null}
      {!shared ? (
        <p className="px-0.5 pt-1 text-[12px] text-[var(--mc-ink-muted)]">
          Loading the plans shared with you.
        </p>
      ) : shared.length === 0 ? (
        <p className="px-0.5 pt-1 text-[12px] leading-relaxed text-[var(--mc-ink-muted)]">
          Nothing shared with you yet
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-2">
          {shared.map((plan) => {
            const copy = copies.get(keyOf(plan));
            const others = plan.members.filter((member) => member.id !== me?.id);
            return (
              <div key={keyOf(plan)} className="flex flex-col gap-1" data-shared-plan={plan.name}>
                <LibraryTile
                  icon={plan.icon ?? undefined}
                  name={plan.name}
                  creator={plan.ownerName}
                  when={formatRelativeDate(plan.planUpdatedAt || plan.updatedAt)}
                  machines={copy?.stats?.machines}
                  tier={copy?.stats?.tier}
                  euT={copy?.stats?.euT}
                  marks={{ open: copy ? !copy.closed : false }}
                  busy={busy === keyOf(plan)}
                  menuOpen={menu?.key === keyOf(plan)}
                  onOpen={() => void open(plan)}
                  onMenu={(left, top) => setMenu({ key: keyOf(plan), left, top })}
                />
                <div className="flex items-center gap-1 px-1" aria-label="Who is in it">
                  <Face username={plan.ownerName} color={colorFor(plan.ownerId)} size={16} />
                  {others.map((member) => (
                    <Face
                      key={member.id}
                      username={member.username}
                      color={colorFor(member.id)}
                      size={16}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {menu && menuPlan ? (
        <LibraryMenu
          left={menu.left}
          top={menu.top}
          label={`Options for ${menuPlan.name}`}
          onClose={() => setMenu(undefined)}
        >
          <MenuItem
            label="Open"
            onClick={() => {
              setMenu(undefined);
              void open(menuPlan);
            }}
          />
          <MenuItem
            label="Leave this plan"
            tone="danger"
            disabled={!me}
            onClick={() => {
              setMenu(undefined);
              void leave(menuPlan);
            }}
          />
        </LibraryMenu>
      ) : null}
    </div>
  );
}
