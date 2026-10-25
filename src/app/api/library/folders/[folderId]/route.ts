import { NextResponse } from "next/server";
import type { FolderUpsertBody } from "@/lib/library/sync-types";
import {
  readJsonCapped,
  REQUEST_TOO_BIG_MESSAGE,
  SMALL_JSON_MAX_BYTES,
} from "@/lib/server/http/request-body";
import { serviceResponse } from "@/lib/server/http/service-response";
import { isSignedIn, readViewer } from "@/lib/server/http/viewer";
import { isLibraryId } from "@/lib/server/library";
import { isDatabaseConfigured } from "@/lib/server/services/config";
import { deleteFolder, folderSaveAllowed, saveFolder } from "@/lib/server/services/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ folderId: string }> };

/** Upsert, client timestamps, newer row wins (`saveFolder`). */
export async function PUT(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }
  const allowed = await folderSaveAllowed(viewer);
  if (!allowed.ok) {
    return serviceResponse(allowed, () => ({}));
  }

  const { folderId } = await context.params;
  if (!isLibraryId(folderId)) {
    return NextResponse.json({ error: "Bad folder id." }, { status: 400 });
  }
  const read = await readJsonCapped(request, SMALL_JSON_MAX_BYTES);
  if (!read.ok) {
    return read.status === 413
      ? NextResponse.json({ error: REQUEST_TOO_BIG_MESSAGE }, { status: 413 })
      : NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const body = (read.value ?? {}) as Partial<FolderUpsertBody>;
  return serviceResponse(await saveFolder(viewer, folderId, body), (saved) => saved);
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "Cloud storage is not configured." }, { status: 503 });
  }
  const viewer = await readViewer(request);
  if (!isSignedIn(viewer)) {
    return NextResponse.json({ error: "Sign in to sync your library." }, { status: 401 });
  }
  const { folderId } = await context.params;
  return serviceResponse(await deleteFolder(viewer, folderId), (deleted) => deleted);
}
