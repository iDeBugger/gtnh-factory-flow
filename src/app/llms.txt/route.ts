import { llmsText } from "@/lib/server/site/site-files";

/** The site as one page of markdown for language-model crawlers (`llmsText` in site-files.ts). */
export const revalidate = 3600;

export async function GET() {
  return new Response(await llmsText(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
