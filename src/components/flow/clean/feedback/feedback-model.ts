import { APP_VERSION } from "@/lib/version";
import { mixHex } from "../colors";

/**
 * The Feedback box's pure parts: the face pictures, the sentence naming what goes with the words, the issue's
 * title, and the report as `/api/feedback` takes it. A report from the page says so (`origin: "web"`): its own
 * device id (`web-<uuid>`), the page's version as `mod`, the browser's platform as `os`, and no pack, Java or log.
 * The route's guard (`src/lib/server/feedback-guard.ts`) knows that shape, gives it stricter limits and its own label.
 */

export type FeedbackKind = "bug" | "idea" | "help";
export type FeedbackMood = "happy" | "okay" | "sad";

export const KINDS: ReadonlyArray<{ id: FeedbackKind; label: string; colour: string }> = [
  { id: "bug", label: "Bug", colour: "#E5484D" },
  { id: "idea", label: "Idea", colour: "#FCD34D" },
  { id: "help", label: "Help", colour: "#60A5FA" },
];
export const MOODS: readonly FeedbackMood[] = ["happy", "okay", "sad"];
export const MOOD_INK = ["#5EE9B5", "#E7C35A", "#E57373"] as const;
export const DISCORD_URL = "https://discord.com/channels/181078474394566657/1531402304530682036";

export function promptFor(kind: FeedbackKind): string {
  return kind === "bug"
    ? "What happened, and what did you expect?"
    : kind === "idea"
      ? "What would make the planner better?"
      : "Quick questions do well on the Discord.";
}

/**
 * What goes with the words, as a sentence: the open plan by name, and its picture. The site keeps the plan's
 * task board and comments out of the public issue, and the line says so.
 */
export function sendsLine(planName: string | undefined, picture: boolean): string {
  const parts: string[] = [];
  if (planName !== undefined) {
    parts.push(`the open plan '${planName}'`);
    if (picture) parts.push("a picture of it");
  }
  if (parts.length === 0) return "Nothing goes with it but your words.";
  const last = parts.pop()!;
  return `Sent with it: ${parts.length ? `${parts.join(", ")} and ${last}` : last}. Tasks and comments stay out.`;
}

/** The issue's title: the first line written, cut at a word (the mod's rule). */
export function titleOf(text: string): string {
  const trimmed = text.trim();
  let first = trimmed ? (trimmed.split("\n", 2)[0] ?? "").trim() : "";
  if (first.length > 100) {
    const cut = first.lastIndexOf(" ", 97);
    first = `${first.slice(0, cut > 40 ? cut : 97)}...`;
  }
  return first;
}

const DEVICE_KEY = "gtnhplanner.feedback.web-device";

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

/** The sender's id: `web-` and a UUID, made once and kept (the route limits per device). */
export function deviceId(): string {
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY);
    if (stored && /^web-[0-9a-f-]{36}$/.test(stored)) return stored;
    const made = `web-${uuid()}`;
    window.localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return `web-${uuid()}`;
  }
}

function osName(): string {
  if (typeof navigator === "undefined") return "Web";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const raw = nav.userAgentData?.platform || nav.platform || "Web";
  const clean = raw.replace(/[^A-Za-z0-9 ._()/+-]/g, "").trim().slice(0, 100);
  return clean || "Web";
}

export function versions(): { mod: string; pack: string; java: string; os: string } {
  return { mod: APP_VERSION, pack: "", java: "", os: osName() };
}

export interface ReportInput {
  kind: FeedbackKind;
  mood?: FeedbackMood;
  text: string;
  plan?: { name: string; plan: unknown };
  /** PNG, base64, no prefix. */
  picture?: string;
}

export function buildReport(input: ReportInput): Record<string, unknown> {
  return {
    origin: "web",
    kind: input.kind,
    ...(input.mood ? { mood: input.mood } : {}),
    title: titleOf(input.text),
    description: input.text.trim().slice(0, 8000),
    deviceId: deviceId(),
    versions: versions(),
    plans: input.plan ? [input.plan] : [],
    ...(input.picture ? { picture: input.picture } : {}),
  };
}

export interface FaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

const FACE = 14;
const FROM = [3, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 3];

/**
 * A face for a mood on the mod's 14 pixel grid: a disc with the corners cut in the shade, in its colour but
 * for a crescent at the bottom right, softer until hovered or picked, a white ring once picked.
 */
export function faceRects(mood: number, picked: boolean, hot: boolean, surface = "#23252A"): FaceRect[] {
  const ink = MOOD_INK[mood] ?? MOOD_INK[0];
  const dark = "#15171A";
  const soft = !picked && !hot;
  const fill = soft ? mixHex(ink, surface, 0.7) : ink;
  const shade = mixHex(fill, dark, 0.85);
  const feature = soft ? mixHex(dark, fill, 0.85) : dark;
  const rects: FaceRect[] = [];
  const white = "#FFFFFF";
  if (picked) {
    rects.push({ x: 2, y: -1, w: FACE - 4, h: FACE + 2, fill: white });
    rects.push({ x: 0, y: 0, w: FACE, h: FACE, fill: white });
    rects.push({ x: -1, y: 2, w: FACE + 2, h: FACE - 4, fill: white });
  }
  for (let row = 0; row < FACE; row++) {
    const from = FROM[row]!;
    rects.push({ x: from, y: row, w: FACE - 2 * from, h: 1, fill: shade });
    if (row + 1 === FACE) continue;
    const next = FROM[row + 1]!;
    const a = Math.max(from, next - 1);
    const b = Math.min(FACE - from, FACE - next - 1);
    if (b > a) rects.push({ x: a, y: row, w: b - a, h: 1, fill });
  }
  rects.push({ x: 4, y: 4, w: 2, h: 2, fill: feature }, { x: 8, y: 4, w: 2, h: 2, fill: feature });
  if (mood === 0) {
    rects.push(
      { x: 3, y: 8, w: 1, h: 1, fill: feature },
      { x: 4, y: 9, w: 6, h: 1, fill: feature },
      { x: 10, y: 8, w: 1, h: 1, fill: feature },
    );
  } else if (mood === 1) {
    rects.push({ x: 4, y: 9, w: 6, h: 1, fill: feature });
  } else {
    rects.push(
      { x: 3, y: 10, w: 1, h: 1, fill: feature },
      { x: 4, y: 9, w: 6, h: 1, fill: feature },
      { x: 10, y: 10, w: 1, h: 1, fill: feature },
    );
  }
  return rects;
}
