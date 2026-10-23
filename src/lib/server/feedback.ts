import { z } from "zod";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { factoryProjectSchema } from "@/lib/model/schemas";
import type { FactoryProject } from "@/lib/model/types";

/**
 * Reports sent from the in-game planner's Feedback box, opened as issues on the
 * planner's GitHub repo by a token only this server holds, so a player needs no
 * GitHub account. The mod strips paths, names and addresses from the log and the
 * crash report before sending; the issue is public, and the box says so.
 */

export const FEEDBACK_MAX_BYTES = 4 * 1024 * 1024;
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 8000;
const TEXT_MAX = 60_000;
const VERSION_MAX = 100;
const PLANS_MAX = 5;
const PLAN_NAME_MAX = 120;
const PICTURE_MAX_BYTES = 3 * 1024 * 1024;
/** A plan's open link goes in the issue only when it is this short; past it the plan is a file. */
const LINK_MAX = 8000;
/** GitHub refuses an issue body over 65,536 characters; the plans move to a comment past this. */
const BODY_MAX = 60_000;

/** Where reports go and how each kind is labelled there: the game's to the mod's repo, the web planner's to the website's. */
export const FEEDBACK_REPO = "jackwrichards/gtnh-planner-mod";
export const FEEDBACK_WEB_REPO = "jackwrichards/gtnh-factory-flow";

/** The repo a report opens its issue on (`GITHUB_FEEDBACK_REPO` and `GITHUB_FEEDBACK_WEB_REPO` override). */
export function feedbackRepo(origin: "game" | "web" | undefined, env: Record<string, string | undefined> = process.env): string {
  return origin === "web"
    ? env.GITHUB_FEEDBACK_WEB_REPO || FEEDBACK_WEB_REPO
    : env.GITHUB_FEEDBACK_REPO || FEEDBACK_REPO;
}
/**
 * Whether this deployment takes a report with this body's origin. The game's
 * reports (origin absent or `game`) come only while the mod integration is on;
 * the web planner's always do. Read from the raw JSON so the answer comes
 * before the report is parsed or counted.
 */
export function feedbackOriginServed(json: unknown): boolean {
  if (isModAndCommunityOn()) {
    return true;
  }
  return typeof json === "object" && json !== null && (json as { origin?: unknown }).origin === "web";
}

export const FROM_GAME_LABEL = "from game";
export const FROM_WEB_LABEL = "from web";
const KIND_LABELS = { bug: "bug", idea: "enhancement", help: "question" } as const;
const KIND_TITLES = { bug: "Bug", idea: "Idea", help: "Help" } as const;
const MOODS = { happy: "Happy", okay: "Okay", sad: "Unhappy" } as const;

const versionText = z.string().max(VERSION_MAX).default("");

const reportSchema = z.object({
  /** Where it was sent from. The game sends nothing here; the web planner says `web`. */
  origin: z.enum(["game", "web"]).default("game"),
  kind: z.enum(["bug", "idea", "help"]),
  mood: z.enum(["happy", "okay", "sad"]).optional(),
  title: z.string().trim().min(1, "Give it a title.").max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters.`),
  description: z.string().max(DESCRIPTION_MAX, `Keep the description under ${DESCRIPTION_MAX} characters.`).default(""),
  deviceId: z.string().min(1).max(100),
  versions: z
    .object({ mod: versionText, pack: versionText, java: versionText, os: versionText })
    .default({ mod: "", pack: "", java: "", os: "" }),
  plans: z
    .array(z.object({ name: z.string().max(PLAN_NAME_MAX).default(""), plan: z.unknown() }))
    .max(PLANS_MAX, `Send at most ${PLANS_MAX} plans.`)
    .default([]),
  picture: z.string().max(Math.ceil((PICTURE_MAX_BYTES * 4) / 3) + 4, "The picture is too big.").optional(),
  log: z.string().max(TEXT_MAX).optional(),
  crash: z.string().max(TEXT_MAX).optional(),
});

export type FeedbackKind = keyof typeof KIND_LABELS;

/** A report as checked: plans parsed as projects, the picture as PNG bytes. */
export interface FeedbackReport {
  /** `game` when absent. */
  origin?: "game" | "web";
  kind: FeedbackKind;
  mood?: keyof typeof MOODS;
  title: string;
  description: string;
  deviceId: string;
  versions: { mod: string; pack: string; java: string; os: string };
  plans: { name: string; plan: FactoryProject }[];
  picture?: Buffer;
  log?: string;
  crash?: string;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** The report, or why not in words the player can act on. */
export function parseFeedback(body: unknown): FeedbackReport | { error: string } {
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That report could not be read." };
  }
  const r = parsed.data;
  if (r.origin === "web" && (r.log !== undefined || r.crash !== undefined)) {
    return { error: "That report could not be read." };
  }
  const plans: FeedbackReport["plans"] = [];
  for (const entry of r.plans) {
    const plan = factoryProjectSchema.safeParse(entry.plan);
    if (!plan.success) {
      return { error: `The plan "${entry.name}" could not be read.` };
    }
    plans.push({ name: entry.name || plan.data.name || "Plan", plan: plan.data });
  }
  let picture: Buffer | undefined;
  if (r.picture) {
    picture = Buffer.from(r.picture, "base64");
    if (picture.length > PICTURE_MAX_BYTES || !PNG_MAGIC.every((b, i) => picture?.[i] === b)) {
      return { error: "The picture is not a PNG the site can take." };
    }
  }
  return {
    origin: r.origin,
    kind: r.kind,
    mood: r.mood,
    title: r.title,
    description: r.description.trim(),
    deviceId: r.deviceId,
    versions: r.versions,
    plans,
    picture,
    log: r.log?.trim() || undefined,
    crash: r.crash?.trim() || undefined,
  };
}

/** Where each attachment ended up: a plan's open link and file, the picture. */
export interface FeedbackLinks {
  plans: { name: string; cards: number; link?: string; file?: string }[];
  picture?: string;
}

export function issueTitle(report: FeedbackReport): string {
  return `${KIND_TITLES[report.kind]}: ${report.title}`.slice(0, 250);
}

export function issueLabels(report: FeedbackReport): string[] {
  return [report.origin === "web" ? FROM_WEB_LABEL : FROM_GAME_LABEL, KIND_LABELS[report.kind]];
}

/**
 * The issue: what the player wrote, the plans and picture, the log and crash report folded away, and the versions.
 * The plans come back separately when they would push the body past GitHub's limit.
 */
export function issueBody(report: FeedbackReport, links: FeedbackLinks): { body: string; plansComment?: string } {
  const head = [
    `**${KIND_TITLES[report.kind]}** sent from ${report.origin === "web" ? "the web planner" : "the game"}${report.mood ? `, feeling: ${MOODS[report.mood]}` : ""}`,
    "",
    report.description ? quiet(report.description) : "_No description._",
  ];
  const plans = plansSection(links);
  const picture = links.picture ? ["", `![The open plan](${links.picture})`] : [];
  const folded = [
    ...(report.log ? ["", details("The end of the game log", report.log)] : []),
    ...(report.crash ? ["", details("The crash report", report.crash)] : []),
  ];
  const v = report.versions;
  const foot = [
    "",
    "---",
    quiet(
      [v.mod && `GTNH Planner ${report.origin === "web" ? "web " : ""}${v.mod}`, v.pack && `GTNH ${v.pack}`, v.java && `Java ${v.java}`, v.os]
        .filter(Boolean)
        .join(" · "),
    ),
  ];
  const whole = [...head, ...plans, ...picture, ...folded, ...foot].join("\n");
  if (whole.length <= BODY_MAX) {
    return { body: whole };
  }
  const plansComment = plans.length ? plans.join("\n").trim() : undefined;
  const rest = [...head, ...(plansComment ? ["", "_The plans are in the first comment._"] : []), ...picture, ...folded, ...foot]
    .join("\n")
    .slice(0, BODY_MAX);
  return { body: rest, plansComment: plansComment?.slice(0, BODY_MAX) };
}

function plansSection(links: FeedbackLinks): string[] {
  if (!links.plans.length) {
    return [];
  }
  const lines = ["", "### Plans"];
  for (const p of links.plans) {
    const parts = [`**${quiet(p.name)}** (${p.cards} ${p.cards === 1 ? "card" : "cards"})`];
    if (p.link) parts.push(`[open in the planner](${p.link})`);
    if (p.file) parts.push(`[plan file](${p.file})`);
    lines.push(`- ${parts.join(" · ")}`);
  }
  return lines;
}

/**
 * Text from the player that cannot ping anyone, link an issue, or show a picture, a link or HTML: mentions and
 * references are broken up, and brackets and tags escaped. Bare addresses still autolink, as text.
 */
function quiet(text: string): string {
  return text
    .replace(/@(?=[\w-])/g, "@​")
    .replace(/#(?=\d)/g, "#​")
    .replace(/[\\[\]<>]/g, (c) => ({ "\\": "\\\\", "[": "\\[", "]": "\\]", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** Folded text in a fence nothing inside can close. */
function details(summary: string, text: string): string {
  const fenced = text.replace(/~~~~/g, "~~~​~");
  return `<details><summary>${summary}</summary>\n\n~~~~text\n${fenced}\n~~~~\n\n</details>`;
}

/** The plan as a file, for when its open link is too long for the issue. */
export function planFile(plan: FactoryProject): string {
  return JSON.stringify(plan);
}

/** Whether an open link is short enough to sit in the issue. */
export function linkFits(link: string): boolean {
  return link.length <= LINK_MAX;
}

/** Opens the issue (and the plans' comment), as the token's account. Its number and page. */
export async function openIssue(
  token: string,
  repo: string,
  issue: { title: string; body: string; labels: string[]; plansComment?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ number: number; url: string }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "gtnhplanner-feedback",
  };
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const created = (await response.json()) as { number: number; html_url: string };
  if (issue.plansComment) {
    // Best effort: the issue stands without its plans.
    await fetchImpl(`https://api.github.com/repos/${repo}/issues/${created.number}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: issue.plansComment }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
  }
  return { number: created.number, url: created.html_url };
}
