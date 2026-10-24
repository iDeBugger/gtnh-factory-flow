import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { encodePlanCode, planCodeLink } from "@/lib/import-export/plan-code";
import { isModAndCommunityOn } from "@/lib/deployment-features";
import { clientAddress, isCommunityConfigured, saltedKey } from "@/lib/server/community";
import { modAndCommunityOffResponse } from "@/lib/server/mod-and-community-gate";
import {
  FEEDBACK_MAX_BYTES,
  feedbackRepo,
  type FeedbackLinks,
  issueBody,
  issueLabels,
  issueTitle,
  feedbackOriginServed,
  linkFits,
  openIssue,
  parseFeedback,
  planFile,
} from "@/lib/server/feedback";
import { removeFeedbackFiles, storeFeedbackFile } from "@/lib/server/feedback-files";
import { claimIssue, feedbackGate, looksGenuine } from "@/lib/server/feedback-guard";
import { readTextCapped } from "@/lib/server/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Where the issues are opened, and the site the links point at. */
const SITE = "https://gtnhplanner.com";

/** A refusal, counted against its sender towards the gate's flood pause. */
function refuse(sender: string, status: number, error: string): NextResponse {
  feedbackGate.refused(sender);
  return NextResponse.json({ error }, { status });
}

/**
 * A report from the in-game Feedback box, opened as a GitHub issue on the planner's repo. Answers the issue's
 * number and page, which the game shows. `feedback-guard.ts` has what a report must get past first.
 */
export async function POST(request: Request) {
  // With the mod integration off the game's reports are answered as absent,
  // so the body is read first: they never count against the gate the web
  // planner's reports share, and absent comes before the server's own
  // readiness, as on every other gated route. The read is capped, since it
  // runs ahead of the gate.
  let early: string | undefined;
  if (!isModAndCommunityOn()) {
    early = await readTextCapped(request, FEEDBACK_MAX_BYTES);
    if (early === undefined) {
      return NextResponse.json({ error: "The report is too big. Send fewer plans." }, { status: 413 });
    }
    let peek: unknown;
    try {
      peek = JSON.parse(early);
    } catch {
      peek = undefined;
    }
    if (peek !== undefined && !feedbackOriginServed(peek)) {
      return modAndCommunityOffResponse();
    }
  }
  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  if (!token || !isCommunityConfigured()) {
    return NextResponse.json({ error: "Reports can't be sent yet." }, { status: 503 });
  }
  // The files stored for this report so far, removed again if no issue
  // comes to link to them.
  const id = randomUUID();
  const stored: string[] = [];
  try {
    // The sender is the salted address, computed once: the gate keys its
    // shares and its flood count on it and never sees the address itself.
    const sender = saltedKey(clientAddress(request));
    const gate = feedbackGate.admit(sender);
    if (gate === "paused") {
      return NextResponse.json({ error: "Reports are paused for a while. Try again later." }, { status: 503 });
    }
    if (gate === "sender") {
      return NextResponse.json({ error: "That's a lot of reports. Slow down." }, { status: 429 });
    }
    if (gate === "busy") {
      return NextResponse.json({ error: "Lots of reports are coming in. Try again in a few minutes." }, { status: 429 });
    }
    const raw = early ?? (await readTextCapped(request, FEEDBACK_MAX_BYTES));
    if (raw === undefined) {
      return refuse(sender, 413, "The report is too big. Send fewer plans.");
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return refuse(sender, 400, "That report could not be read.");
    }
    const report = parseFeedback(json);
    if ("error" in report) {
      return refuse(sender, 400, report.error);
    }
    if (!looksGenuine(report)) {
      return refuse(sender, 400, "That report could not be read.");
    }
    const refusal = await claimIssue(request, report);
    if (refusal) {
      return refuse(sender, refusal.status, refusal.error);
    }

    const links: FeedbackLinks = { plans: [] };
    for (let i = 0; i < report.plans.length; i++) {
      const { name, plan } = report.plans[i]!;
      let link: string | undefined;
      try {
        const candidate = planCodeLink(await encodePlanCode(plan), SITE);
        link = linkFits(candidate) ? candidate : undefined;
      } catch {
        link = undefined;
      }
      const fileName = `plan-${i + 1}.json`;
      const file = await storeFeedbackFile(SITE, id, fileName, Buffer.from(planFile(plan)), "application/json");
      if (file) {
        stored.push(fileName);
      }
      links.plans.push({ name, cards: plan.nodes.length, link, file });
    }
    if (report.picture) {
      links.picture = await storeFeedbackFile(SITE, id, "picture.png", report.picture, "image/png");
      if (links.picture) {
        stored.push("picture.png");
      }
    }

    const { body, plansComment } = issueBody(report, links);
    const issue = await openIssue(token, feedbackRepo(report.origin), {
      title: issueTitle(report),
      body,
      labels: issueLabels(report),
      plansComment,
    });
    return NextResponse.json(issue, { status: 201 });
  } catch (error) {
    console.error("feedback report failed", error);
    await removeFeedbackFiles(id, stored);
    return NextResponse.json({ error: "The report could not be sent. Try again later." }, { status: 502 });
  }
}
