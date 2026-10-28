import type { LivePerson } from "@/lib/live/protocol";
import { useLiveSession, type LiveStatus } from "@/store/live-session";
import { isModAndCommunityOn } from "@/lib/deployment-features";

/** A face's name: a player in the game says so, unless the mod is switched off (then the game is never named). */
export function liveFaceName(person: Pick<LivePerson, "username" | "client">): string {
  return person.client === "game" && isModAndCommunityOn() ? `${person.username} (in game)` : person.username;
}

/** Up to two letters for a face: the name's first, and the first after a break if any. */
export function initialsOf(username: string): string {
  const name = username.trim();
  if (!name) {
    return "?";
  }
  const parts = name.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Dark ink on light colours (the palette's yellow), white on the rest. */
export function inkOn(color: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    return "#fff";
  }
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#111" : "#fff";
}

export function Face({
  username,
  color,
  size = 20,
  title,
}: {
  username: string;
  color: string;
  size?: number;
  title?: string;
}) {
  return (
    <span
      title={title ?? username}
      aria-label={title ?? username}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold ring-2 ring-surface"
      style={{
        width: size,
        height: size,
        background: color,
        color: inkOn(color),
        fontSize: Math.round(size * 0.45),
        lineHeight: 1,
      }}
    >
      {initialsOf(username)}
    </span>
  );
}

/** Faces of whoever else has the open live plan open: one per account. */
export function LiveFaces({ max = 5 }: { max?: number }) {
  const present = useLiveSession((state) => state.present);
  const status = useLiveSession((state) => state.status);
  if (status === "off" || present.length === 0) {
    return null;
  }
  const shown = present.slice(0, max);
  const more = present.length - shown.length;
  return (
    <div
      data-live-faces
      className="flex shrink-0 items-center -space-x-1.5"
      aria-label={`Here now: ${present.map((person) => person.username).join(", ")}`}
    >
      {shown.map((person: LivePerson) => (
        <Face
          key={person.id}
          username={person.username}
          color={person.color}
          title={liveFaceName(person)}
        />
      ))}
      {more > 0 ? (
        <span
          className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-raised px-1 text-[10px] font-semibold text-fg-muted ring-2 ring-surface"
          title={present
            .slice(max)
            .map((person) => person.username)
            .join(", ")}
        >
          +{more}
        </span>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<Exclude<LiveStatus, "off">, string> = {
  live: "Live",
  connecting: "Connecting",
  offline: "Offline",
};

const STATUS_DOT: Record<Exclude<LiveStatus, "off">, string> = {
  live: "bg-emerald-400",
  connecting: "bg-amber-400",
  offline: "bg-neutral-500",
};

/** Whether the open plan is live: edits saved as you make them, or waiting for the connection. */
export function LiveStatusChip() {
  const status = useLiveSession((state) => state.status);
  const pending = useLiveSession((state) => state.pending);
  if (status === "off") {
    return null;
  }
  const waiting = status !== "live" && pending > 0;
  const title =
    status === "live"
      ? "Live: every edit is saved as you make it."
      : status === "connecting"
        ? "Connecting to the live plan."
        : "Offline: your edits are kept here and go when the connection is back.";
  return (
    <span
      data-live-status={status}
      title={title}
      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-[11px] text-fg-muted"
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${STATUS_DOT[status]}`} />
      <span>
        {STATUS_LABEL[status]}
        {waiting ? ` (${pending} waiting)` : ""}
      </span>
    </span>
  );
}
