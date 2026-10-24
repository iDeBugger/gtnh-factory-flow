"use client";

import "./chrome.css";
import "./library.css";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loginCommunityUser, registerCommunityUser } from "@/lib/community/client";
import { PASSWORD_MIN_LENGTH, SIGN_IN_PASSWORD_MIN_LENGTH } from "@/lib/community/types";
import { useCommunityUser } from "@/components/community/auth";
import { useDropdownDismiss } from "@/lib/hooks/use-dropdown-dismiss";
import { getUiScale } from "@/lib/ui-scale";
import { CHROME_SCREEN_K, type ChromeAnchor } from "./ChromeMenu";

/** The sign-in form, hung from the account key: sign in, or make an account (a name and a password, no email). */
export function SignInPanel({ anchor, onClose }: { anchor: ChromeAnchor; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { setUser } = useCommunityUser();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useDropdownDismiss(true, { refs: [ref], onClose, insideSelector: "[data-menu-anchor]" });
  // The panel wears the bar's extra zoom (chrome.css .mm, CHROME_SCREEN_K): its box is in those pixels.
  const scale = getUiScale() * CHROME_SCREEN_K;
  const vw = window.innerWidth / scale;

  // A new account needs the longer password; signing in takes what the account was made with.
  const minPassword = mode === "login" ? SIGN_IN_PASSWORD_MIN_LENGTH : PASSWORD_MIN_LENGTH;
  const incomplete = username.trim().length < 3 || password.length < minPassword;

  const submit = async () => {
    if (busy || incomplete) return;
    setBusy(true);
    setError(undefined);
    try {
      const signedIn =
        mode === "login" ? await loginCommunityUser(username, password) : await registerCommunityUser(username, password);
      setUser(signedIn);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Sign in"
      className="mm ml-signpanel ui-zoom"
      style={{ top: anchor.bottom / scale + 2, right: Math.max(2, vw - (anchor.right ?? anchor.left) / scale) }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="ml-sign-title">{mode === "login" ? "Sign in" : "Create an account"}</div>
        <div className="ml-sign-sub">Your plans are kept in your account</div>
        <label className="ml-sign-label">USERNAME</label>
        <input
          autoFocus
          className="ml-search ml-sign-field"
          placeholder="Username"
          autoComplete="username"
          maxLength={24}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <label className="ml-sign-label">PASSWORD</label>
        <input
          className="ml-search ml-sign-field"
          type="password"
          placeholder="Password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <div className="ml-sign-error">{error}</div> : <div className="ml-sign-gap" />}
        <button className="ml-sign-go" type="submit" disabled={busy || incomplete}>
          {busy ? "..." : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <div
          className="ml-sign-switch"
          role="button"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(undefined);
          }}
        >
          {mode === "login" ? "No account yet? Create one" : "Have an account? Sign in"}
        </div>
      </form>
    </div>,
    document.body,
  );
}
