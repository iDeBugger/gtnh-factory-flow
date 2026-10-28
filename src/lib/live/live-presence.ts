import { useSyncExternalStore } from "react";
import type { LiveClientKind, LiveCursor } from "./protocol";

/**
 * Where everyone else in the open live plan is pointing and what they have
 * selected, for the board's presence layer. Kept out of every store the
 * board reads: a cursor moving re-renders the cursor layer and nothing else,
 * and a selection changing re-renders only the outlines.
 */

export interface RemoteCursor {
  /** The connection: one account can be in a plan twice (a game and a browser). */
  conn: string;
  who: string;
  username: string;
  color: string;
  client: LiveClientKind;
  /** Board coordinates, the plan's own; null when their pointer left the board. */
  cursor: LiveCursor;
}

export interface RemoteSelection {
  conn: string;
  who: string;
  username: string;
  color: string;
  ids: string[];
}

interface Person {
  who: string;
  username: string;
  color: string;
  client: LiveClientKind;
}

const people = new Map<string, Person>();
const cursors = new Map<string, LiveCursor>();
const selections = new Map<string, string[]>();

const EMPTY_CURSORS: RemoteCursor[] = [];
const EMPTY_SELECTIONS: RemoteSelection[] = [];
let cursorSnapshot: RemoteCursor[] = EMPTY_CURSORS;
let selectionSnapshot: RemoteSelection[] = EMPTY_SELECTIONS;
const cursorListeners = new Set<() => void>();
const selectionListeners = new Set<() => void>();

function publishCursors(): void {
  const next: RemoteCursor[] = [];
  for (const [conn, cursor] of cursors) {
    const person = people.get(conn);
    if (person) {
      next.push({ conn, ...person, cursor });
    }
  }
  cursorSnapshot = next.length === 0 ? EMPTY_CURSORS : next;
  cursorListeners.forEach((listener) => listener());
}

function publishSelections(): void {
  const next: RemoteSelection[] = [];
  for (const [conn, ids] of selections) {
    const person = people.get(conn);
    if (person && ids.length > 0) {
      next.push({ conn, who: person.who, username: person.username, color: person.color, ids });
    }
  }
  selectionSnapshot = next.length === 0 ? EMPTY_SELECTIONS : next;
  selectionListeners.forEach((listener) => listener());
}

/** Who is in the room now (everyone but this connection); anyone gone loses their cursor. */
export function setPresentPeople(
  present: Array<Person & { conn: string }>,
  ownConn: string | undefined,
): void {
  people.clear();
  for (const person of present) {
    if (person.conn !== ownConn) {
      people.set(person.conn, {
        who: person.who,
        username: person.username,
        color: person.color,
        client: person.client,
      });
    }
  }
  for (const conn of [...cursors.keys()]) {
    if (!people.has(conn)) {
      cursors.delete(conn);
    }
  }
  let selectionsChanged = false;
  for (const conn of [...selections.keys()]) {
    if (!people.has(conn)) {
      selections.delete(conn);
      selectionsChanged = true;
    }
  }
  // Names and colours ride on both layers.
  publishCursors();
  if (selectionsChanged || selections.size > 0) {
    publishSelections();
  }
}

/** One relayed presence frame. */
export function notePresence(conn: string, cursor: LiveCursor | null, sel: string[]): void {
  if (!people.has(conn)) {
    return;
  }
  const before = cursors.get(conn);
  if (cursor) {
    if (!before || before.x !== cursor.x || before.y !== cursor.y) {
      cursors.set(conn, { x: cursor.x, y: cursor.y });
      publishCursors();
    }
  } else if (before) {
    cursors.delete(conn);
    publishCursors();
  }
  const previous = selections.get(conn) ?? [];
  if (previous.length !== sel.length || previous.some((id, index) => id !== sel[index])) {
    if (sel.length === 0) {
      selections.delete(conn);
    } else {
      selections.set(conn, sel.slice());
    }
    publishSelections();
  }
}

/** Nobody else here: the plan closed or the connection went. */
export function clearPresence(): void {
  if (people.size === 0 && cursors.size === 0 && selections.size === 0) {
    return;
  }
  people.clear();
  cursors.clear();
  selections.clear();
  publishCursors();
  publishSelections();
}

function subscribeCursors(listener: () => void): () => void {
  cursorListeners.add(listener);
  return () => cursorListeners.delete(listener);
}

function subscribeSelections(listener: () => void): () => void {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

export function useRemoteCursors(): RemoteCursor[] {
  return useSyncExternalStore(
    subscribeCursors,
    () => cursorSnapshot,
    () => EMPTY_CURSORS,
  );
}

export function useRemoteSelections(): RemoteSelection[] {
  return useSyncExternalStore(
    subscribeSelections,
    () => selectionSnapshot,
    () => EMPTY_SELECTIONS,
  );
}

export function readRemoteCursors(): RemoteCursor[] {
  return cursorSnapshot;
}

export function readRemoteSelections(): RemoteSelection[] {
  return selectionSnapshot;
}
