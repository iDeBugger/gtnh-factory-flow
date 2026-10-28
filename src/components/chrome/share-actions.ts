import { useEffect, useState } from "react";
import { flashNotice } from "@/components/flow/clean/rail/NoticeBar";
import { copyToClipboard } from "@/lib/clipboard";
import { encodePlanCode, planCodeLink } from "@/lib/import-export/plan-code";
import type { FactoryProject } from "@/lib/model/types";
import {
  findModGame,
  localNetworkPermission,
  sendPlanToMod,
  type ModGame,
} from "@/lib/mod-link/mod-link";
import type { MenuEntry } from "./ChromeMenu";

/** Copies the plan's link: this site with the plan after `#p=`. It opens here, and pastes into the mod's + tab. */
export async function copyPlanLink(project: FactoryProject): Promise<void> {
  try {
    const code = await encodePlanCode(project);
    const copied = await copyToClipboard(planCodeLink(code, window.location.origin));
    flashNotice(copied ? "info" : "warn", copied ? "Copied the plan link." : "Couldn't copy the plan link.");
  } catch (error) {
    console.error(error);
    flashNotice("warn", "Couldn't copy the plan link.");
  }
}

/** Copies the plan code alone, for the mod's + tab or a paste here. */
export async function copyPlanCode(project: FactoryProject): Promise<void> {
  try {
    const copied = await copyToClipboard(await encodePlanCode(project));
    flashNotice(copied ? "info" : "warn", copied ? "Copied the plan code." : "Couldn't copy the plan code.");
  } catch (error) {
    console.error(error);
    flashNotice("warn", "Couldn't copy the plan code.");
  }
}

/**
 * Sends the plan to the game. The game asks the player before it opens anything. When the game cannot be reached
 * (not running, or the browser keeps the page from this computer), the plan code goes on the clipboard instead.
 */
export async function openInMod(project: FactoryProject, game?: ModGame): Promise<boolean> {
  let code: string;
  try {
    code = await encodePlanCode(project);
  } catch (error) {
    console.error(error);
    flashNotice("warn", "Couldn't write the plan out.");
    return false;
  }
  if (await sendPlanToMod(code, project.name || "Untitled plan", game)) {
    flashNotice("info", "Sent to the game. Open it there.");
    return true;
  }
  const copied = await copyToClipboard(code);
  flashNotice(
    "warn",
    copied
      ? "Couldn't reach the game. The plan code is copied: paste it in the planner's + tab."
      : "Couldn't reach the game. Use Copy plan code and paste it in the planner's + tab.",
  );
  return false;
}

/**
 * Whether a game is there to take a plan, asked as the Share menu opens: `found` (it answered), `asks` (the
 * browser asks the player before the page may reach this computer, so it is not probed until the row is
 * picked), `blocked` (the player told the browser no: the row copies the code instead), `none` (nothing
 * answered), or `checking`.
 */
export type ModReach =
  | { kind: "checking" }
  | { kind: "found"; game: ModGame }
  | { kind: "asks" }
  | { kind: "blocked" }
  | { kind: "none" };

export function useModReach(active: boolean): ModReach {
  const [reach, setReach] = useState<ModReach>({ kind: "checking" });
  useEffect(() => {
    if (!active) return;
    let live = true;
    void (async () => {
      const permission = await localNetworkPermission();
      // Probing now would pop the browser's question the moment the menu opens: wait for the row.
      if (permission === "prompt") {
        if (live) setReach({ kind: "asks" });
        return;
      }
      // Denied still probes: a page served from this computer needs no permission to reach it.
      const game = await findModGame();
      if (live) setReach(game ? { kind: "found", game } : permission === "denied" ? { kind: "blocked" } : { kind: "none" });
    })();
    return () => {
      live = false;
      // The next opening asks again from the start.
      setReach({ kind: "checking" });
    };
  }, [active]);
  return reach;
}

/** The Share menu's "Open in the game" row for what the probe found. */
export function openInModRow(reach: ModReach, project: () => FactoryProject): MenuEntry {
  if (reach.kind === "blocked") {
    return {
      label: "Open in the game",
      tip: "Your browser keeps this page from the game. This copies the plan code for the planner's + tab.",
      onSelect: () => void copyCodeForMod(project()),
    };
  }
  const ready = reach.kind === "found" || reach.kind === "asks";
  return {
    label: "Open in the game",
    disabled: !ready,
    tip: ready ? "Send this plan to the game. It asks before it opens it." : "Start the game with GTNH Planner installed",
    onSelect: () => void openInMod(project(), reach.kind === "found" ? reach.game : undefined),
  };
}

/** The fallback when the browser keeps the page from the game: the code, for the planner's + tab. */
async function copyCodeForMod(project: FactoryProject): Promise<void> {
  try {
    const copied = await copyToClipboard(await encodePlanCode(project));
    flashNotice(
      copied ? "info" : "warn",
      copied
        ? "The plan code is copied. Paste it in the planner's + tab."
        : "Couldn't copy the plan code. Use Copy plan code and paste it in the planner's + tab.",
    );
  } catch (error) {
    console.error(error);
    flashNotice("warn", "Couldn't write the plan out.");
  }
}
