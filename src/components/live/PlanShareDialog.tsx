import "../chrome/mod-panel.css";
import { LoaderCircle, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogA11y } from "@/lib/hooks/use-dialog-a11y";
import {
  addPlanMember,
  fetchPlanMembers,
  removePlanMember,
  searchAccounts,
  type PlanMembers,
} from "@/lib/library/cloud-library";
import { syncLibraryNow } from "@/lib/library/library-sync";
import type { PlanMember } from "@/lib/library/sync-types";
import { LIBRARY_MAX_MEMBERS } from "@/lib/library/sync-types";
import { colorFor } from "@/lib/live/protocol";
import { useCommunityAuthStore } from "@/store/community-auth-store";
import { useDesignStore } from "@/store/design-store";
import { noteLeavingPlan, useLiveSession } from "@/store/live-session";
import { Face } from "./LiveFaces";
import { isModAndCommunityOn } from "@/lib/deployment-features";

/**
 * Who the open plan is shared with. The owner adds people by name and
 * removes them; someone it is shared with sees who else is in it and can
 * leave. Everyone in it edits it live together. Where the community library is
 * on, posting a copy to Community is a separate thing (the Share menu's Publish
 * to library): it posts a copy, never this plan. In the mod's panel skin, as the
 * other boxes of its bar.
 */
export function PlanShareDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, { onClose, initialFocus: "#plan-share-search" });
  const user = useCommunityAuthStore((state) => state.user);
  const design = useDesignStore((state) =>
    state.designs.find((entry) => entry.id === state.activeDesignId),
  );
  const removeDesign = useDesignStore((state) => state.removeDesign);
  const me = useLiveSession((state) => state.me);

  const sharedRef = design?.cloud;
  const remoteId = sharedRef?.designId ?? design?.id;
  const ownerId = sharedRef?.ownerId;
  const synced = Boolean(sharedRef || design?.remoteUpdatedAt);
  const isOwner = !sharedRef;

  const [info, setInfo] = useState<PlanMembers>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  // Plans are created in the account as they appear; this only covers a row still on its way.
  useEffect(() => {
    if (user && design && !synced) {
      void syncLibraryNow();
    }
  }, [user, design, synced]);

  useEffect(() => {
    if (!user || !remoteId || !synced) {
      return;
    }
    let cancelled = false;
    fetchPlanMembers(remoteId, ownerId).then(
      (loaded) => {
        if (!cancelled) {
          setInfo(loaded);
          setLoadError(undefined);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Sharing could not be loaded.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [user, remoteId, ownerId, synced]);

  // The live room hears sharing changes first (someone leaving, another tab).
  const ownLiveDoc = me && remoteId ? `${ownerId ?? me.id}:${remoteId}` : undefined;
  useEffect(
    () =>
      useLiveSession.subscribe((state, previous) => {
        if (ownLiveDoc && state.doc === ownLiveDoc && state.members !== previous.members) {
          setInfo((current) => (current ? { ...current, members: state.members } : current));
        }
      }),
    [ownLiveDoc],
  );

  const members = info?.members ?? [];
  const full = members.length >= LIBRARY_MAX_MEMBERS;

  const add = async (account: PlanMember) => {
    if (!remoteId) {
      return;
    }
    setBusy(account.id);
    setActionError(undefined);
    try {
      const next = await addPlanMember(remoteId, account.id);
      setInfo((current) => (current ? { ...current, members: next } : current));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not share the plan.");
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (member: PlanMember) => {
    if (!remoteId) {
      return;
    }
    setBusy(member.id);
    setActionError(undefined);
    try {
      const next = await removePlanMember(remoteId, member.id);
      setInfo((current) => (current ? { ...current, members: next } : current));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not remove them.");
    } finally {
      setBusy(undefined);
    }
  };

  const leave = async () => {
    if (!remoteId || !ownerId || !me || !design) {
      return;
    }
    setBusy("leave");
    setActionError(undefined);
    try {
      noteLeavingPlan(ownerId, remoteId);
      await removePlanMember(remoteId, me.id, ownerId);
      onClose();
      await removeDesign(design.id, { fromSync: true });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not leave the plan.");
      setBusy(undefined);
    }
  };

  return (
    <div
      className="pn-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Plan together"
        data-plan-share-dialog
        className="pn pn-skin"
      >
        <div className="pn-title">
          <span>Plan together</span>
          <button type="button" onClick={onClose} aria-label="Close" className="pn-x" />
        </div>
        <div className="pn-body">
          {!user ? (
            <p className="text-sm text-fg-muted">Sign in to invite.</p>
          ) : loadError ? (
            <p className="text-sm text-red-400">{loadError}</p>
          ) : !synced || !info ? (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Loading.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-fg-muted">
                {isModAndCommunityOn()
                  ? "Everyone here can edit the plan with you, live. Posting a copy to Community is separate."
                  : "Everyone here can edit the plan with you, live."}
              </p>
              <ul className="space-y-1" data-plan-members>
                <li className="flex items-center gap-2 text-sm">
                  <Face username={info.ownerName || "?"} color={colorFor(info.ownerId)} />
                  <span className="min-w-0 flex-1 truncate">
                    {isOwner ? "You" : info.ownerName}
                    <span className="ml-1 text-xs text-fg-muted">owner</span>
                  </span>
                </li>
                {members.map((member) => {
                  const isMe = member.id === me?.id;
                  return (
                    <li
                      key={member.id}
                      className="flex items-center gap-2 text-sm"
                      data-member={member.username}
                    >
                      <Face username={member.username} color={colorFor(member.id)} />
                      <span className="min-w-0 flex-1 truncate">
                        {isMe ? "You" : member.username}
                      </span>
                      {isOwner ? (
                        <button
                          type="button"
                          disabled={busy !== undefined}
                          onClick={() => void remove(member)}
                          className="rounded border border-line px-2 py-0.5 text-xs text-fg-subtle hover:border-line-strong hover:text-fg disabled:opacity-50"
                        >
                          {busy === member.id ? "Removing" : "Remove"}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {isOwner ? (
                full ? (
                  <p className="text-xs text-fg-muted">
                    A plan can be shared with {LIBRARY_MAX_MEMBERS} people at most.
                  </p>
                ) : (
                  <AccountSearch
                    exclude={new Set([info.ownerId, ...members.map((member) => member.id)])}
                    busyId={busy}
                    onPick={(account) => void add(account)}
                  />
                )
              ) : (
                <button
                  type="button"
                  disabled={busy !== undefined || !me}
                  onClick={() => void leave()}
                  className="rounded border border-red-800 px-3 py-1 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-50"
                >
                  {busy === "leave" ? "Leaving" : "Leave this plan"}
                </button>
              )}
              {actionError ? <p className="text-sm text-red-400">{actionError}</p> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Finds accounts by the start of their name, asking once typing pauses. */
function AccountSearch({
  exclude,
  busyId,
  onPick,
}: {
  exclude: Set<string>;
  busyId?: string;
  onPick: (account: PlanMember) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlanMember[]>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const prefix = query.trim();
    // The server answers one typed character with nothing: the box says so
    // instead of asking, and an earlier answer does not stay listed.
    if (prefix.length < 2) {
      setResults(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchAccounts(prefix, controller.signal).then(
        (accounts) => {
          setResults(accounts);
          setError(undefined);
          setSearching(false);
        },
        (failure: unknown) => {
          if (controller.signal.aborted) {
            return;
          }
          setError(failure instanceof Error ? failure.message : "Search failed.");
          setSearching(false);
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const typed = query.trim();
  const shown = useMemo(
    () => (typed ? (results ?? []) : []).filter((account) => !exclude.has(account.id)),
    [typed, results, exclude],
  );

  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-fg-muted" htmlFor="plan-share-search">
        Add someone
      </label>
      <input
        id="plan-share-search"
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSearching(event.target.value.trim().length >= 2);
        }}
        placeholder="Search by name"
        autoComplete="off"
        maxLength={24}
        className="h-8 w-full rounded border border-line-strong bg-surface-sunken px-2 text-sm outline-none focus:border-cyan-600"
      />
      {error ? <p className="text-xs text-red-400">{error}</p> : null}
      {typed.length === 1 ? <p className="text-xs text-fg-muted">Type two letters at least.</p> : null}
      {typed && !searching && results && shown.length === 0 ? (
        <p className="text-xs text-fg-muted">No one by that name.</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto" data-account-results>
          {shown.map((account) => (
            <li key={account.id}>
              <button
                type="button"
                disabled={busyId !== undefined}
                onClick={() => {
                  onPick(account);
                  setQuery("");
                  setResults(undefined);
                }}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-surface-raised disabled:opacity-50"
              >
                <Face username={account.username} color={colorFor(account.id)} />
                <span className="min-w-0 flex-1 truncate">{account.username}</span>
                <UserPlus className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
                <span className="sr-only">Add</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
