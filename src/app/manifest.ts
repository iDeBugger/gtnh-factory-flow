import type { MetadataRoute } from "next";
import { webManifest } from "@/lib/server/site/site-files";

/** The web app manifest (`webManifest` in site-files.ts). */
export default function manifest(): MetadataRoute.Manifest {
  return webManifest();
}
