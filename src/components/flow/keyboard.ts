import { readLibraryTabState } from "@/lib/library/library-tab";
import { readWelcomeTabState } from "@/lib/welcome/welcome-tab";
import { useFactoryStore } from "@/store/factory-store";

/**
 * Board-wide keyboard shortcuts must never fire while the user is typing:
 * Delete means "delete a character", Ctrl+Z means "undo my typing", Ctrl+C
 * means "copy my text". Anything that handles board keys checks here first.
 */
export function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

/**
 * Something lies over the board and has the keyboard: the recipe search (a bare Backspace walks its pages back, as
 * in NEI), the Library, Welcome, a task board, or a menu or dialog holding the focus (a card's right-click menu, a
 * header menu). The board's keys that change the plan do nothing then: they would act on cards the player is not
 * looking at, behind a menu that still points at them.
 */
export function isBoardCovered(): boolean {
  const state = useFactoryStore.getState();
  const focused = typeof document === "undefined" ? null : document.activeElement;
  return (
    Boolean(focused?.closest('[role="menu"], [role="dialog"]')) ||
    Boolean(state.recipeBrowserResource) ||
    state.project.primaryView === "tasks" ||
    readLibraryTabState().active ||
    readWelcomeTabState().active
  );
}
