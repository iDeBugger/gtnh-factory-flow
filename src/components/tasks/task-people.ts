import { useMemo } from "react";
import { colorFor } from "@/lib/live/protocol";
import type { TaskAuthor } from "@/lib/tasks/task-board";
import { useLiveSession } from "@/store/live-session";

export interface TaskPerson {
  id: string;
  username: string;
  color: string;
}

/** Who you are on this device's task boards when not signed in. */
export const LOCAL_AUTHOR: TaskAuthor = { id: "local", username: "You" };

/** You, as tasks and comments name you: your account, or this device. */
export function useTaskAuthor(): TaskAuthor {
  const me = useLiveSession((state) => state.me);
  return useMemo(() => (me ? { id: me.id, username: me.username } : LOCAL_AUTHOR), [me]);
}

/**
 * Who a task can be given to: on a shared plan its owner and members, on a
 * plan of yours alone just you (when signed in), else nobody.
 */
export function useTaskPeople(): TaskPerson[] {
  const status = useLiveSession((state) => state.status);
  const owner = useLiveSession((state) => state.owner);
  const members = useLiveSession((state) => state.members);
  const me = useLiveSession((state) => state.me);
  return useMemo(() => {
    const people = new Map<string, TaskPerson>();
    const add = (person: { id: string; username: string } | undefined) => {
      if (person && !people.has(person.id)) {
        people.set(person.id, { ...person, color: colorFor(person.id) });
      }
    };
    if (status !== "off" && owner) {
      add(owner);
      members.forEach(add);
    }
    add(me);
    return [...people.values()];
  }, [status, owner, members, me]);
}
