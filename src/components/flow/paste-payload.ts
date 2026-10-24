import { preparePayloadForPlan } from "@/lib/datasets/convert-payload-version";
import { useFactoryStore, type BoardClipboardPayload } from "@/store/factory-store";
import { flashNotice } from "./clean/rail/NoticeBar";

/** What a paste says when another version's cards could not be matched because the match service failed. */
export const PASTE_FAILED_TEXT = "Couldn't paste those cards. Try again.";

/**
 * Pastes `payload` into the plan on the board, converted for its game version first (`preparePayloadForPlan`), so
 * cards copied on another version never land with that version's bodies. Nothing lands when the player switched to
 * another plan while the conversion ran. Returns the pasted ids, empty when nothing landed.
 */
export async function pastePayloadIntoPlan(
  payload: BoardClipboardPayload,
  offset: { x: number; y: number },
): Promise<string[]> {
  const project = useFactoryStore.getState().project;
  let prepared: BoardClipboardPayload;
  try {
    prepared = await preparePayloadForPlan(payload, project);
  } catch (error) {
    console.error(error);
    flashNotice("warn", PASTE_FAILED_TEXT);
    return [];
  }
  const state = useFactoryStore.getState();
  if (state.project.id !== project.id) {
    return [];
  }
  return state.pasteBoardItems(prepared, offset);
}
