import { useMemo } from "react";
import { inkOn } from "@/components/live/LiveFaces";
import { PixelRuns } from "@/components/chrome/pixel-icons";
import { colorFor } from "@/lib/live/protocol";
import type { PlanTask, PlanTaskPriority, PlanTaskStatus } from "@/lib/model/types";
import {
  TASK_PRIORITY_COLOR,
  timeDotColor,
  timeDotCount,
  inColumnDays,
} from "@/lib/tasks/task-board";
import { TASK_STATUS_COLOR } from "@/lib/tasks/task-links";
import { useFactoryStore } from "@/store/factory-store";
import { useTaskAuthor, useTaskPeople } from "./task-people";

/**
 * How the task board looks, the game's TaskLook: a status's dot, a priority's arrow, the dots for days in a column,
 * people's faces (initials on their colour, square and flat). Sizes are the mod's GUI pixels.
 */

type Runs = ReadonlyArray<readonly [number, number, number]>;

const ARROW_UP: Runs = [
  [3, 0, 1],
  [2, 1, 3],
  [1, 2, 5],
  [0, 3, 7],
  [2, 4, 3],
  [2, 5, 3],
];
const ARROW_DOWN: Runs = [
  [2, 0, 3],
  [2, 1, 3],
  [0, 2, 7],
  [1, 3, 5],
  [2, 4, 3],
  [3, 5, 1],
];
const BAR: Runs = [
  [0, 2, 7],
  [0, 3, 7],
];

/** A priority's icon, 7 by 6: an arrow up for high, a bar for medium, an arrow down for low. */
export function PriorityIcon({
  priority,
  className,
}: {
  priority: PlanTaskPriority;
  className?: string;
}) {
  return (
    <PixelRuns
      runs={priority === "high" ? ARROW_UP : priority === "low" ? ARROW_DOWN : BAR}
      width={7}
      height={6}
      className={className}
      style={{ color: TASK_PRIORITY_COLOR[priority] }}
    />
  );
}

export function StatusDot({ status, size = 6 }: { status: PlanTaskStatus; size?: number }) {
  return (
    <span
      className="tb-dot"
      aria-hidden
      style={{ width: size, height: size, background: TASK_STATUS_COLOR[status] }}
    />
  );
}

/** Dots across for a task's days in its column: 3 by 3 with 2 between, one a day to four, none in Done. */
export function TimeDots({ task }: { task: PlanTask }) {
  const count = timeDotCount(task);
  if (count === 0) {
    return null;
  }
  const color = timeDotColor(inColumnDays(task));
  return (
    <span className="tb-time" aria-hidden data-time-dots={count}>
      {Array.from({ length: count }, (_, at) => (
        <i key={at} style={{ background: color }} />
      ))}
    </span>
  );
}

/** Up to two initials, as the game makes them: a name's first letter, or the first letters of its first two words. */
export function initialsFor(name: string | undefined): string {
  if (!name || !name.trim()) {
    return "?";
  }
  const words = name
    .trim()
    .split(/[\s_.-]+/)
    .filter(Boolean);
  let out = "";
  for (const word of words) {
    out += [...word][0] ?? "";
    if (out.length >= 2 || words.length < 2) break;
  }
  return out.toUpperCase();
}

/** Someone's face: their initials on their colour, square with its corners cut, 12 high. */
export function TaskFace({ id, name }: { id: string; name: string | undefined }) {
  const color = colorFor(id);
  return (
    <span
      className="tb-face"
      style={{ background: color, color: inkOn(color) }}
      title={name ?? "Someone"}
    >
      {initialsFor(name)}
    </span>
  );
}

export function TaskFaces({
  ids,
  nameOf,
}: {
  ids: readonly string[];
  nameOf: (id: string) => string | undefined;
}) {
  if (ids.length === 0) {
    return null;
  }
  return (
    <span className="tb-faces">
      {ids.map((id) => (
        <TaskFace key={id} id={id} name={nameOf(id)} />
      ))}
    </span>
  );
}

/**
 * Someone's name by account id, as the game finds it: yours, else as the plan's room names its owner and members,
 * else the name their comments carry.
 */
export function useNameOf(): (id: string) => string | undefined {
  const people = useTaskPeople();
  const me = useTaskAuthor();
  const comments = useFactoryStore((state) => state.project.taskComments);
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const comment of comments ?? []) {
      if (comment.byName) names.set(comment.by, comment.byName);
    }
    for (const person of people) names.set(person.id, person.username);
    names.set("local", "You");
    names.set(me.id, me.username);
    return (id: string) => names.get(id);
  }, [people, me, comments]);
}
