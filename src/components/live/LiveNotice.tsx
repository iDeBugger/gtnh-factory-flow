import { Info, X } from "lucide-react";
import { dismissLiveNotice, useLiveSession } from "@/store/live-session";

/** What the live plan needs you to know: an edit refused, a plan taken away. */
export function LiveNotice() {
  const notice = useLiveSession((state) => state.notice);
  if (!notice) {
    return null;
  }
  return (
    <div
      role="status"
      data-live-notice
      className="flex min-w-0 items-center gap-2 border-b border-sky-700/60 bg-sky-950/60 px-3 py-1.5 text-xs text-sky-100"
    >
      <Info aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 flex-1">{notice.text}</p>
      {notice.action ? (
        <button
          type="button"
          data-live-notice-action
          onClick={notice.action.run}
          className="shrink-0 rounded border border-sky-500/70 px-2 py-0.5 text-sky-50 hover:bg-sky-900/60"
        >
          {notice.action.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismissLiveNotice}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-sky-200 hover:bg-sky-900/60"
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
