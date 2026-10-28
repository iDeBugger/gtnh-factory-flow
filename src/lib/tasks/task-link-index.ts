import { create } from "zustand";
import { readDesign } from "@/lib/designs/design-storage";
import type { PlanTask, PlanTaskItem, PlanTaskStatus } from "@/lib/model/types";
import { useDesignStore } from "@/store/design-store";
import { useFactoryStore } from "@/store/factory-store";
import { myAccountId } from "@/store/live-session";
import { itemLink, linkKey, morePressing, planLinkId, planLinkIds, taskLinks } from "./task-links";

/**
 * Which cards some task is about, from the task boards loaded on this device
 * (the open design when it is a task board, the others read from storage):
 * the most pressing status among the tasks that link each card. A card wears
 * a dot in that status's colour. Rebuilt a moment after the library or the
 * open board's tasks change; nothing is read while no board has a task.
 */
interface TaskLinkIndex {
  /** Link key (plan and card) -> its most pressing task's status. */
  statuses: Record<string, PlanTaskStatus>;
  /** The spellings of the open plan's id in links. */
  planIds: string[];
}

export const useTaskLinkIndex = create<TaskLinkIndex>(() => ({ statuses: {}, planIds: [] }));

/** The status of the most pressing task that links the open plan's card, or undefined. */
export function useCardTaskStatus(nodeId: string): PlanTaskStatus | undefined {
  return useTaskLinkIndex((state) => {
    let best: PlanTaskStatus | undefined;
    for (const plan of state.planIds) {
      const found = state.statuses[linkKey({ plan, node: nodeId })];
      if (found) {
        best = best ? morePressing(best, found) : found;
      }
    }
    return best;
  });
}

let version = 0;

async function rebuild(): Promise<void> {
  const mine = ++version;
  const { designs, activeDesignId } = useDesignStore.getState();
  const me = myAccountId();
  const active = designs.find((design) => design.id === activeDesignId);
  const statuses: Record<string, PlanTaskStatus> = {};
  const mark = (link: { plan: string; node: string }, status: PlanTaskStatus) => {
    const key = linkKey(link);
    const before = statuses[key];
    statuses[key] = before ? morePressing(before, status) : status;
  };
  // A task's cards: its own links (an older task's) and its machine things'.
  const add = (
    ownPlan: string,
    tasks: readonly PlanTask[] | undefined,
    items: readonly PlanTaskItem[] | undefined,
  ) => {
    const status = new Map<string, PlanTaskStatus>();
    for (const task of tasks ?? []) {
      status.set(task.id, task.status);
      for (const link of taskLinks(task, ownPlan)) {
        mark(link, task.status);
      }
    }
    for (const item of items ?? []) {
      const of = status.get(item.taskId);
      const link = of ? itemLink(item, ownPlan) : undefined;
      if (of && link) {
        mark(link, of);
      }
    }
  };
  const project = useFactoryStore.getState().project;
  for (const design of designs) {
    const isActive = design.id === activeDesignId;
    if (!design.taskBoard && !(isActive && project.primaryView === "tasks")) {
      continue;
    }
    const ownPlan = planLinkId(design, me);
    if (isActive) {
      add(ownPlan, project.tasks, project.taskItems);
      continue;
    }
    const record = await readDesign(design.id).catch(() => undefined);
    if (mine !== version) {
      return;
    }
    add(ownPlan, record?.project.tasks, record?.project.taskItems);
  }
  if (mine === version) {
    useTaskLinkIndex.setState({
      statuses,
      planIds: active ? planLinkIds(active, me) : [],
    });
  }
}

/** Keeps the index current. Mounted once by the app shell, with live plans (task boards come with them). */
export function startTaskLinkIndex(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 150);
  };
  const stopDesigns = useDesignStore.subscribe((state, previous) => {
    if (state.designs !== previous.designs || state.activeDesignId !== previous.activeDesignId) {
      queue();
    }
  });
  const stopProject = useFactoryStore.subscribe((state, previous) => {
    if (
      state.project.tasks !== previous.project.tasks ||
      state.project.taskItems !== previous.project.taskItems
    ) {
      queue();
    }
  });
  queue();
  return () => {
    clearTimeout(timer);
    stopDesigns();
    stopProject();
  };
}
