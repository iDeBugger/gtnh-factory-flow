import { useEffect, useRef, useState } from "react";
import "./chrome/mod-panel.css";
import { Download, Play, X } from "lucide-react";

/**
 * Closing the announcement in any way (the X, Dismiss, Escape, the backdrop,
 * or following Get the mod) stamps this key, and it never opens again in this
 * browser. Bump the version suffix only for a new announcement that every
 * player should see once more.
 */
export const MOD_ANNOUNCEMENT_KEY = "gtnh-factory-flow.mod-announcement-dismissed.v1";

/** The mod's newest release: GitHub resolves `latest` to it. */
export const MOD_RELEASE_URL = "https://github.com/jackwrichards/gtnh-planner-mod/releases/latest";

/** Opens a moment after load, so the board is up and the popup is not a flash on arrival. */
const OPEN_DELAY_MS = 1200;

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(MOD_ANNOUNCEMENT_KEY) !== null;
  } catch {
    // Storage blocked: never nag on every visit, so treat it as seen.
    return true;
  }
}

function markDismissed(): void {
  try {
    window.localStorage.setItem(MOD_ANNOUNCEMENT_KEY, new Date().toISOString());
  } catch {
    // A blocked or full quota must never break the app.
  }
}

/**
 * The one popup that opens by itself: GTNH Planner is now a mod, with its
 * trailer and the download. Shown once per browser; closing it is final.
 */
export function ModAnnouncement() {
  const [isOpen, setOpen] = useState(false);

  useEffect(() => {
    if (wasDismissed()) {
      return;
    }
    const timer = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        markDismissed();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  function close() {
    markDismissed();
    setOpen(false);
  }

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className={[
        "fixed inset-0 z-[130] grid place-items-center p-4",
        // No backdrop filter on a phone: it repaints the animated board beneath
        // every frame. Compact gets a darker opaque sheet instead.
        "bg-neutral-950/75 backdrop-blur-sm compact:bg-neutral-950/92 compact:[backdrop-filter:none]",
      ].join(" ")}
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mod-announcement-title"
        className="pn-skin flex max-h-[calc(94*var(--ui-vh))] w-full max-w-5xl flex-col overflow-hidden border border-line-strong bg-surface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative shrink-0 px-7 pb-5 pt-6 compact:px-4 compact:pb-4 compact:pt-5">
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute right-3 top-3 z-10 rounded p-1.5 text-fg-subtle hover:bg-surface-raised hover:text-fg"
          >
            <X className="h-5 w-5" />
          </button>
          <h2
            id="mod-announcement-title"
            className="pr-8 text-[22px] leading-tight compact:text-[16px]"
          >
            GTNH <span className="text-cyan-400">Planner</span> is now in the game!
          </h2>
          <p className="mt-2 text-lg text-fg-muted compact:text-base">
            Plan your factories right from NEI, just like the site. Check out the video!
          </p>
        </div>

        <TrailerPlayer />

        <div className="flex shrink-0 items-center justify-end gap-3 px-7 py-4 compact:px-4">
          <button
            type="button"
            onClick={close}
            className={`${ACTION} border-line-strong text-fg-subtle hover:bg-surface-raised`}
          >
            Dismiss
          </button>
          <a
            href={MOD_RELEASE_URL}
            target="_blank"
            rel="noreferrer"
            onClick={markDismissed}
            className={`${ACTION} border-cyan-600 bg-cyan-600/20 text-cyan-200 hover:bg-cyan-600/30`}
          >
            <Download className="h-4 w-4" aria-hidden />
            Get the mod
          </a>
        </div>
      </div>
    </div>
  );
}

/** Both actions share one box, so they stand the same height whatever is inside. */
const ACTION =
  "inline-flex h-10 items-center gap-2 rounded border px-5 text-sm font-bold leading-none";

/**
 * The trailer, still on its poster under a big play key until asked: the
 * browser draws its controls over a paused video as a dark band, so they
 * appear only once it plays. It never autoplays: sound and data are the
 * player's to spend.
 */
function TrailerPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  return (
    // Capped to what the title and the actions leave of the window, so they are
    // never pushed off a short screen; the picture letterboxes inside.
    <div className="relative aspect-video max-h-[calc(94*var(--ui-vh)-11rem)] min-h-0 w-full bg-black">
      <video
        ref={videoRef}
        className="block h-full w-full object-contain"
        src="/announce/in-game-trailer.mp4"
        poster="/announce/in-game-trailer.jpg"
        controls={started}
        playsInline
        preload="metadata"
      />
      {started ? null : (
        <button
          type="button"
          aria-label="Play the trailer"
          onClick={() => {
            setStarted(true);
            void videoRef.current?.play();
          }}
          className="group absolute inset-0 grid place-items-center"
        >
          <span className="grid h-20 w-20 place-items-center rounded-full bg-cyan-500/90 shadow-2xl transition-transform group-hover:scale-110 compact:h-14 compact:w-14">
            <Play
              className="ml-1 h-9 w-9 fill-white text-white compact:h-6 compact:w-6"
              aria-hidden
            />
          </span>
        </button>
      )}
    </div>
  );
}
