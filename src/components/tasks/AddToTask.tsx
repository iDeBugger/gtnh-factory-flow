import { create } from "zustand";
import { ChromeMenu, type ChromeAnchor, type MenuEntry } from "@/components/chrome/ChromeMenu";
import {
  addCardsToTask,
  taskBoardChoices,
  taskChoices,
  type TaskBoardChoice,
  type TaskCard,
  type TaskChoice,
} from "@/lib/tasks/make-task";
import { TASK_STATUS_COLOR } from "@/lib/tasks/task-links";

/**
 * Add to a task's two menus (the game's TaskActions.addMenu): "Which task board" (each with how many tasks, then New
 * task board), then the board's tasks (New task in To do first, then the tasks under way, each with its status dot and
 * its things done of all). Opened from anywhere with `openAddToTask`; mounted once beside the board.
 */
interface AddToTaskState {
  open?: {
    cards: TaskCard[];
    anchor: ChromeAnchor;
    boards?: TaskBoardChoice[];
    board?: TaskBoardChoice;
    tasks?: TaskChoice[];
  };
}

const useAddToTask = create<AddToTaskState>(() => ({}));

export async function openAddToTask(cards: TaskCard[], anchor: ChromeAnchor): Promise<void> {
  if (cards.length === 0) return;
  useAddToTask.setState({ open: { cards, anchor } });
  const boards = await taskBoardChoices();
  const now = useAddToTask.getState().open;
  if (now?.cards === cards) useAddToTask.setState({ open: { ...now, boards } });
}

async function pickBoard(board: TaskBoardChoice): Promise<void> {
  const now = useAddToTask.getState().open;
  if (!now) return;
  useAddToTask.setState({ open: { ...now, board, tasks: undefined } });
  const tasks = await taskChoices(board.id);
  const after = useAddToTask.getState().open;
  if (after?.board === board) useAddToTask.setState({ open: { ...after, tasks } });
}

function close() {
  useAddToTask.setState({ open: undefined });
}

export function AddToTaskMenu() {
  const open = useAddToTask((state) => state.open);
  if (!open || (!open.board && !open.boards) || (open.board && !open.tasks)) return null;
  const { cards } = open;
  if (open.board && open.tasks) {
    const board = open.board;
    const entries: MenuEntry[] = [
      {
        label: "New task",
        detail: "in To do",
        plus: true,
        onSelect: () => void addCardsToTask(cards, board.id),
      },
      ...open.tasks.map((task, at) => ({
        label: task.title,
        dot: TASK_STATUS_COLOR[task.status],
        detail: task.all === 0 ? "" : `${task.done}/${task.all}`,
        ruleAbove: at === 0,
        onSelect: () => void addCardsToTask(cards, board.id, task.id),
      })),
    ];
    return (
      <ChromeMenu
        anchor={open.anchor}
        entries={entries}
        label="Which task"
        title={board.name}
        minWidth={180}
        onClose={close}
      />
    );
  }
  const boards = open.boards ?? [];
  const entries: MenuEntry[] = [
    ...boards.map((board) => ({
      label: board.name,
      detail: board.tasks === 0 ? "" : `${board.tasks} ${board.tasks === 1 ? "task" : "tasks"}`,
      // The menu stays open for the second step: the row's own close is undone by the next menu opening.
      onSelect: () => {
        const anchor = open.anchor;
        useAddToTask.setState({ open: { cards, anchor, boards } });
        void pickBoard(board);
      },
    })),
    {
      label: "New task board",
      ruleAbove: boards.length > 0,
      onSelect: () => void addCardsToTask(cards, undefined),
    },
  ];
  return (
    <ChromeMenu
      anchor={open.anchor}
      entries={entries}
      label="Which task board"
      title="Which task board"
      minWidth={160}
      onClose={close}
    />
  );
}
