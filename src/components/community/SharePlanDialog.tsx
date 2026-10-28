import "../chrome/mod-panel.css";
import { Check, Link2, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogA11y } from "@/lib/hooks/use-dialog-a11y";
import { isLiveConfigured } from "@/lib/live/live-config";
import { normalizeBlueprintTags } from "@/lib/blueprints/types";
import {
  listCommunityPlans,
  patchCommunityPlan,
  uploadCommunityPlan,
  uploadPlanPreview,
} from "@/lib/community/client";
import { computeCommunityPlanStats } from "@/lib/community/plan-stats";
import { capturePlanPreviewPng } from "@/lib/community/plan-preview-capture";
import { sharedPlanLink } from "@/lib/community/shared-link";
import type { CommunityPlanSummary, EntryIcon } from "@/lib/community/types";
import { serializeFactoryProject } from "@/lib/import-export";
import { capturePlanView } from "@/lib/plan-view";
import { openLibrary } from "@/lib/library/library-tab";
import { notifySetupsChanged } from "@/lib/setups-tab";
import { useFactoryStore } from "@/store/factory-store";
import { useDesignStore } from "@/store/design-store";
import { EntryIconSlot, IconPicker, iconSuggestionsFromStats } from "@/components/IconPicker";
import { renderIoStats, TierBadge } from "@/components/shelf-cards";
import { AuthForm, useCommunityUser } from "./auth";

/**
 * What the Share menu asked for: a new post for a plan not posted yet
 * (`save`), the plan's own post brought up to date (`update`), or a new post
 * for a plan already posted (`new`, Post a new copy to Community). The same words as the
 * mod's Share menu.
 */
export type ShareMode = "save" | "update" | "new";

/**
 * Posting the open tab to the library. A post is a copy, like an uploaded
 * file: nothing follows the plan by itself. The plan's own post changes only
 * when the player updates it here.
 *
 * The dialog leads with WHAT is being posted (the tab, its headline numbers),
 * then the post's face: icon, name, description, tags. Updating a linked post
 * keeps its votes and downloads.
 */
export function SharePlanDialog({
  onClose,
  mode: askedMode,
}: {
  onClose: () => void;
  mode?: ShareMode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y(dialogRef, { onClose });
  const project = useFactoryStore((state) => state.project);
  const result = useFactoryStore((state) => state.lastResult);
  const manifest = useFactoryStore((state) => state.datasetManifest);
  const selectedDatasetVersionId = useFactoryStore((state) => state.selectedDatasetVersionId);
  const setProjectCommunityLink = useFactoryStore((state) => state.setProjectCommunityLink);
  const setProjectIdentity = useFactoryStore((state) => state.setProjectIdentity);
  const activeTabName = useDesignStore(
    (state) =>
      state.designs.find((design) => design.id === state.activeDesignId)?.name ?? "Untitled",
  );
  const { user, isLoading: isUserLoading, setUser } = useCommunityUser();

  // The plan's own face comes first: whatever the plan card already says is
  // what the post should say, and the fields here are one last look at it.
  const [name, setName] = useState(project.name || activeTabName || "My factory");
  const [description, setDescription] = useState(project.description ?? "");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [icon, setIcon] = useState<EntryIcon | undefined>(project.icon);
  const [isPickingIcon, setPickingIcon] = useState(false);
  const [myPostsFor, setMyPostsFor] = useState<{
    username: string;
    posts: CommunityPlanSummary[];
  }>();
  const myPosts = user && myPostsFor?.username === user.username ? myPostsFor.posts : [];
  // The plan's own post, when it has one: Update brings it up to date.
  // Post a new copy to Community ignores it and makes another.
  const [mode, setMode] = useState<ShareMode | undefined>(askedMode);
  const linkedPost =
    mode === "new"
      ? undefined
      : myPosts.find((post) => post.id === project.metadata?.communityPlanId);
  const [isUploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [shared, setShared] = useState<{ planId: string; updated?: boolean }>();
  const [isLinkCopied, setLinkCopied] = useState(false);
  const [linkedIsPublic, setLinkedIsPublic] = useState<boolean>();
  const isPublic = linkedIsPublic ?? linkedPost?.isPublic ?? true;

  const stats = useMemo(() => computeCommunityPlanStats(project, result), [project, result]);
  const datasetVersion = manifest?.versions.find(
    (version) => version.id === selectedDatasetVersionId,
  );

  // Once signed in, load the user's existing posts so they can update one.
  useEffect(() => {
    if (!user) {
      return;
    }

    let cancelled = false;
    void listCommunityPlans({ mine: true, pageSize: 48 }).then(
      (response) => {
        if (!cancelled) {
          setMyPostsFor({ username: user.username, posts: response.plans });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [user]);

  const addTagFromInput = () => {
    const next = normalizeBlueprintTags([...tags, tagInput]);
    setTags(next);
    setTagInput("");
    return next;
  };

  const share = async () => {
    setUploading(true);
    setError(undefined);
    try {
      // Photograph the board while the plan uploads: the picture is the post's
      // face on its library page. Best-effort — a failed photo must
      // never fail the post.
      const previewPromise = capturePlanPreviewPng();
      // Whatever is still sitting in the tag input counts as one last tag.
      const finalTags = tagInput.trim() ? addTagFromInput() : tags;
      const payload = {
        name,
        description,
        gameVersion: datasetVersion?.gtnhVersion ?? "",
        datasetVersionId: selectedDatasetVersionId ?? "",
        // The author's workspace view (board and resource panel arrangement)
        // is shared with the plan. Captured at share time rather than stored
        // on the project, so it never leaks into unshared designs.
        plan: JSON.parse(
          serializeFactoryProject({ ...project, view: capturePlanView() }),
        ) as unknown,
        tags: finalTags,
        icon,
      };

      const { id } = await uploadCommunityPlan(payload);
      setShared({ planId: id });
      // The plan remembers its post, so Share offers to update it.
      setProjectCommunityLink(id);

      const preview = await previewPromise;
      if (preview) {
        await uploadPlanPreview(id, preview).catch(() => undefined);
      }
      // The face the post just went out wearing becomes the plan's own, so
      // the plan card and the next share both start from it. Not the name:
      // the post's name and the tab's name are allowed to differ, and the
      // tab stamps its own name back over the plan on every save anyway.
      setProjectIdentity({ description, icon: icon ?? null });
      notifySetupsChanged();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Sharing failed.");
    } finally {
      setUploading(false);
    }
  };

  // The post brought up to date with the plan as it is now: its plan, name,
  // description and icon. Votes, downloads and comments stay; tags are the
  // post's own.
  const update = async () => {
    if (!linkedPost) {
      return;
    }
    setUploading(true);
    setError(undefined);
    try {
      const previewPromise = capturePlanPreviewPng();
      await patchCommunityPlan(linkedPost.id, {
        name: project.name || linkedPost.name,
        description: project.description ?? "",
        icon: project.icon ?? null,
        plan: JSON.parse(
          serializeFactoryProject({ ...project, view: capturePlanView() }),
        ) as unknown,
      });
      setShared({ planId: linkedPost.id, updated: true });
      const preview = await previewPromise;
      if (preview) {
        await uploadPlanPreview(linkedPost.id, preview).catch(() => undefined);
      }
      notifySetupsChanged();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Updating failed.");
    } finally {
      setUploading(false);
    }
  };

  const setLinkedVisibility = async (next: boolean) => {
    if (!linkedPost) {
      return;
    }
    setError(undefined);
    try {
      await patchCommunityPlan(linkedPost.id, { isPublic: next });
      setLinkedIsPublic(next);
      notifySetupsChanged();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Changing visibility failed.");
    }
  };

  const copyShareLink = async () => {
    const planId = shared?.planId ?? linkedPost?.id;
    if (!planId) {
      return;
    }

    const url = sharedPlanLink(planId);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link:", url);
      return;
    }

    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1500);
  };

  const dialogTitle = linkedPost
    ? "Update in Community"
    : mode === "new"
      ? "Post a new copy to Community"
      : isLiveConfigured()
        ? "Post a copy to Community"
        : "Post a copy to Community";

  return (
    <div className="pn-backdrop">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={dialogTitle} className="pn pn-skin" data-wide="">
        <div className="pn-title">
          <span>{dialogTitle}</span>
          <button type="button" onClick={onClose} aria-label="Close" className="pn-x" />
        </div>
        <div className="pn-body">

        {shared ? (
          <div className="space-y-3">
            <p className="text-sm">
              {shared.updated
                ? "Your post is up to date."
                : "Your setup is in Community. When the plan changes, Update in Community brings the post up to date."}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copyShareLink()}
                title="Share link"
                className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                {isLinkCopied ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Copy link
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                openLibrary({ kind: "all" });
              }}
              className="inline-flex rounded border border-cyan-700 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500"
            >
              See it in Community
            </button>
          </div>
        ) : isUserLoading ? (
          <div className="grid place-items-center py-8 text-fg-muted">
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </div>
        ) : !user ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-subtle">
              Sharing needs an account so your posts stay yours: just a username and password.
            </p>
            <AuthForm onSignedIn={setUser} />
          </div>
        ) : linkedPost ? (
          <div className="space-y-3">
            <p className="text-sm">
              Update <span className="font-semibold text-fg">{linkedPost.name}</span> with the
              plan as it is now. Its votes and comments stay.
            </p>
            <p className="text-xs text-fg-subtle">
              {isPublic
                ? "Public: it shows in Community. Anyone who opens it gets their own copy."
                : "Private: only you can see it. The link opens nothing for anyone else."}
            </p>
            {error ? <p className="text-sm text-red-500">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void update()}
                disabled={isUploading || project.nodes.length === 0}
                className="inline-flex items-center gap-2 rounded border border-cyan-700 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isUploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                Update post
              </button>
              <button
                type="button"
                onClick={() => setMode("new")}
                className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                Post a new copy to Community
              </button>
              <button
                type="button"
                onClick={() => void copyShareLink()}
                className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                {isLinkCopied ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Copy link
              </button>
              <button
                type="button"
                onClick={() => void setLinkedVisibility(!isPublic)}
                className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                {isPublic ? "Make it private" : "Make it public"}
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  openLibrary({ kind: "all" });
                }}
                className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                See it in Community
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* A board that never met the auto-arrange goes out exactly as
                messy as it looks right now, and the post wears it forever.
                One quiet nudge, only while the board looks untouched. */}
            {!(project.annotations ?? []).some((annotation) =>
              annotation.id.startsWith("auto-island-box"),
            ) && project.nodes.length >= 6 ? (
              <div className="rounded border border-cyan-700/60 bg-cyan-950/30 p-2 text-xs text-fg-subtle">
                Tip: the post shows your board exactly as it is. The auto-arrange
                button on the board lays it out cleanly in one press, and an icon
                gives the post a face.
              </div>
            ) : null}
            {/* What the board carries: the headline numbers with the tier
                in its GT colour, then the real resource lists side by
                side. No sentence needed — the dialog IS the open tab. */}
            <div className="rounded border border-line bg-surface-raised p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs tabular-nums text-fg-subtle">
                <span>
                  <span className="font-semibold text-fg">{stats.nodeCount}</span> cards
                </span>
                <span>
                  <span className="font-semibold text-fg">{stats.machineCount}</span> machines
                </span>
                {stats.highestTier ? (
                  <span className="flex items-center gap-1.5">
                    up to <TierBadge tier={stats.highestTier} />
                  </span>
                ) : null}
                <span className="ml-auto text-fg-muted">
                  Game version:{" "}
                  <span className="text-fg-subtle">
                    {datasetVersion?.gtnhVersion
                      ? `GTNH ${datasetVersion.gtnhVersion}`
                      : "unknown"}
                  </span>
                </span>
              </div>
              <div className="mt-2 max-h-56 overflow-y-auto">
                {renderIoStats(stats.needs, stats.outputs, { layout: "side-by-side" }) ?? (
                  <p className="text-[11px] text-fg-muted">
                    Nothing comes in or leaves: this plan feeds itself.
                  </p>
                )}
              </div>
            </div>

            <p className="text-xs text-fg-muted">
              Posting as <span className="font-semibold text-fg">{user.username}</span>
            </p>

            <div className="block text-sm">
              <span className="mb-1 block font-medium">Icon and name</span>
              <div className="flex items-center gap-2">
                <EntryIconSlot
                  icon={icon}
                  editable
                  onEdit={() => setPickingIcon(true)}
                  className="!h-9 !w-9 shrink-0 border border-line-strong bg-surface-sunken"
                />
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  className="w-full min-w-0 rounded border border-line-strong bg-surface-sunken px-2 py-1.5"
                />
              </div>
            </div>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Description (optional)</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="What does it make? Any setup notes?"
                className="w-full resize-y rounded border border-line-strong bg-surface-sunken px-2 py-1.5"
              />
            </label>
            <div className="block text-sm">
              <span className="mb-1 block font-medium">Tags (optional)</span>
              <div className="flex flex-wrap items-center gap-1 rounded border border-line-strong bg-surface-sunken px-2 py-1.5">
                {tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setTags(tags.filter((entry) => entry !== tag))}
                    title={`Remove #${tag}`}
                    className="rounded border border-line px-1.5 py-0.5 text-xs text-fg-subtle hover:border-red-500 hover:text-red-500"
                  >
                    #{tag} ×
                  </button>
                ))}
                <input
                  value={tagInput}
                  onChange={(event) => setTagInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === ",") {
                      event.preventDefault();
                      addTagFromInput();
                    }
                  }}
                  placeholder={tags.length === 0 ? "platline, oil, early game..." : ""}
                  className="min-w-24 flex-1 bg-transparent text-sm outline-none"
                />
              </div>
            </div>

            {error ? <p className="text-sm text-red-500">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-line-strong px-3 py-1.5 text-sm hover:bg-surface-raised"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void share()}
                disabled={isUploading || !name.trim() || project.nodes.length === 0}
                className="inline-flex items-center gap-2 rounded border border-cyan-700 bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isUploading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                Post a copy to Community
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
      {isPickingIcon ? (
        <IconPicker
          title="Pick this setup's icon"
          suggestions={iconSuggestionsFromStats(stats.needs, stats.outputs)}
          onPick={(picked) => {
            setIcon(picked);
            setPickingIcon(false);
          }}
          onClear={
            icon
              ? () => {
                  setIcon(undefined);
                  setPickingIcon(false);
                }
              : undefined
          }
          onClose={() => setPickingIcon(false)}
        />
      ) : null}
    </div>
  );
}
