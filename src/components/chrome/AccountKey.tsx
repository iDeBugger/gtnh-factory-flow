import "./chrome.css";

import { useState } from "react";
import { useCommunityUser } from "@/components/community/auth";
import { flashNotice } from "@/components/flow/clean/rail/NoticeBar";
import { signOutEverywhereMessage } from "@/lib/community/client";
import { initialsOf, inkOn } from "@/components/live/LiveFaces";
import { colorFor } from "@/lib/live/protocol";
import { useLiveSession } from "@/store/live-session";
import { BarKey } from "./bar-parts";
import { ChromeMenu, chromeAnchorOf, type ChromeAnchor } from "./ChromeMenu";
import { PixelIcon } from "./pixel-icons";
import { SignInPanel } from "./SignInPanel";

/**
 * The account key, after Share: "Sign in" while signed out (it opens the sign-in form), the account's face (initials in
 * its colour) while signed in, with a menu of the username and Sign out. Short of room the signed-out key is a small
 * person picture like the other icon keys (`pictures`).
 */
export function AccountKey({ pictures = false }: { pictures?: boolean }) {
  const { user, isLoading, signOut, signOutEverywhere } = useCommunityUser();
  const me = useLiveSession((state) => state.me);
  const [open, setOpen] = useState<{ kind: "form" | "menu"; anchor: ChromeAnchor }>();
  if (isLoading) {
    return null;
  }
  const toggle = (kind: "form" | "menu", element: Element) => {
    const anchor = chromeAnchorOf(element);
    setOpen((current) => (current?.kind === kind ? undefined : { kind, anchor }));
  };
  if (!user) {
    return (
      <>
        <BarKey
          id="account"
          label={pictures ? undefined : "Sign in"}
          icon={pictures}
          ariaLabel="Sign in"
          tip="Sign in: your plans are kept in your account, and shared from it"
          open={open?.kind === "form"}
          onClick={(event) => toggle("form", event.currentTarget)}
          menuAnchor
        >
          {pictures ? <PixelIcon name="account" /> : undefined}
        </BarKey>
        {open?.kind === "form" ? <SignInPanel anchor={open.anchor} onClose={() => setOpen(undefined)} /> : null}
      </>
    );
  }
  // The account's own colour comes with the live service's hello; until then the name's.
  const color = me?.username === user.username ? me.color : colorFor(user.username);
  return (
    <>
      <BarKey
        id="account"
        icon
        ariaLabel={`Account: ${user.username}`}
        tip={`Signed in as ${user.username}`}
        tipSub="Sign out"
        open={open?.kind === "menu"}
        onClick={(event) => toggle("menu", event.currentTarget)}
        menuAnchor
      >
        <span className="mb-me" style={{ background: color, color: inkOn(color) }}>
          {initialsOf(user.username)}
        </span>
      </BarKey>
      {open?.kind === "menu" ? (
        <ChromeMenu
          anchor={open.anchor}
          label="Account"
          minWidth={110}
          align="right"
          entries={[
            { label: user.username, disabled: true, onSelect: () => undefined },
            { label: "Sign out", ruleAbove: true, onSelect: () => void signOut() },
            {
              label: "Sign out everywhere",
              tip: "Signs out every browser and game using this account.",
              onSelect: () =>
                void signOutEverywhere().catch((error: unknown) =>
                  flashNotice("warn", signOutEverywhereMessage(error)),
                ),
            },
          ]}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </>
  );
}
