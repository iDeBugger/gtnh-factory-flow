import { create } from "zustand";

/**
 * What the task board's header (in the board toolbar) and the board itself share: the task whose box is open, a
 * count of New task presses, and whether each board shows its columns or its chains. Per tab, never saved in the
 * plan; the view is remembered per board in this browser (the game keeps it per board on each computer).
 */
export type TaskView = "board" | "chain";

interface TaskBoardUi {
  selectedId?: string;
  /** Moves when New task is pressed; the board adds a task on each change. */
  newTaskTick: number;
  /** Each board's view by design id, as this browser remembers it. */
  views: Record<string, TaskView>;
}

const VIEWS_KEY = "gtnhplanner.task-views.v1";

function readViews(): Record<string, TaskView> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const out: Record<string, TaskView> = {};
    if (parsed && typeof parsed === "object") {
      for (const [id, view] of Object.entries(parsed as Record<string, unknown>)) {
        if (view === "chain") out[id] = "chain";
      }
    }
    return out;
  } catch {
    return {};
  }
}

export const useTaskBoardUi = create<TaskBoardUi>(() => ({ newTaskTick: 0, views: readViews() }));

export function selectTask(id: string | undefined): void {
  useTaskBoardUi.setState({ selectedId: id });
}

export function requestNewTask(): void {
  useTaskBoardUi.setState((state) => ({ newTaskTick: state.newTaskTick + 1 }));
}

/** The view a board shows: its columns unless this browser remembers its chains. */
export function useTaskView(designId: string | undefined): TaskView {
  return useTaskBoardUi((state) =>
    designId && state.views[designId] === "chain" ? "chain" : "board",
  );
}

export function setTaskView(designId: string, view: TaskView): void {
  const views = { ...useTaskBoardUi.getState().views };
  if (view === "chain") {
    views[designId] = "chain";
  } else {
    delete views[designId];
  }
  useTaskBoardUi.setState({ views });
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    // A browser that keeps nothing still switches; it forgets on the next load.
  }
}
