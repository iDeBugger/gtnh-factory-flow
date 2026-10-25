import type { CSSProperties } from "react";

/** The mod's 9 x 9 pictures (`Icons.java`), drawn from the same rows of text: '#' lit, '.' clear. */
export const PIXEL_ICONS = {
  undo: ["..#......", ".##......", "#######..", "########.", ".##...##.", "..#...##.", "......##.", "..#####..", "..####..."],
  gear: ["..##.##..", "..#####..", "#########", "###...###", ".##...##.", "###...###", "#########", "..#####..", "..##.##.."],
  help: ["..#####..", ".##...##.", "......##.", ".....##..", "....##...", "....##...", ".........", "....##...", "....##..."],
  bulb: ["...###...", "..##.##..", ".##...##.", ".##...##.", "..##.##..", "...###...", ".........", "...###...", "...###..."],
  check: [".........", ".......##", "......###", ".....###.", "##..###..", "######...", ".####....", "..##.....", "........."],
  comment: [".#######.", "#########", "##.....##", "##.....##", "#########", ".#######.", "..##.....", ".##......", "........."],
  card: ["#########", "#########", "#.......#", "#########", "#.......#", "#.......#", "#.......#", "#########", "........."],
  pin: ["..#####..", ".#######.", ".##...##.", ".##...##.", ".#######.", "..#####..", "...###...", "...###...", "....#...."],
  camera: [".........", "...###...", "#########", "###...###", "##.....##", "###...###", "#########", ".........", "........."],
  plus: [".........", "...##....", "...##....", ".######..", ".######..", "...##....", "...##....", ".........", "........."],
  plans: ["####.####", "####.####", "####.####", "####.####", ".........", "####.####", "####.####", "####.####", "####.####"],
  pencil: ["......##.", ".....###.", "....###..", "...###...", "..###....", ".###.....", "####.....", "###......", "........."],
  account: ["...###...", "..#####..", "..#####..", "...###...", ".........", ".#######.", "#########", "#########", "#########"],
  share: ["...##....", "..####...", ".######..", "...##....", "##.##.##.", "##....##.", "##....##.", "########.", "########."],
} as const;

export type PixelIconName = keyof typeof PIXEL_ICONS;

/** The Non-recipe key's bolt, 7 x 11 (`PowerPicker.bolt`): runs of {x, y, width}. */
const BOLT_RUNS: ReadonlyArray<readonly [number, number, number]> = [
  [4, 0, 3],
  [3, 1, 3],
  [3, 2, 2],
  [2, 3, 3],
  [1, 4, 6],
  [0, 5, 6],
  [3, 6, 2],
  [2, 7, 2],
  [2, 8, 1],
  [1, 9, 1],
  [1, 10, 1],
];

export function PixelIcon({
  name,
  mirror = false,
  className,
  style,
}: {
  name: PixelIconName;
  mirror?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const rows = PIXEL_ICONS[name];
  const d: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x += 1;
        continue;
      }
      const from = x;
      while (x < row.length && row[x] === "#") x += 1;
      const left = mirror ? row.length - x : from;
      d.push(`M${left} ${y}h${x - from}v1h-${x - from}z`);
    }
  });
  return (
    <svg
      className={className}
      style={style}
      width="9"
      height="9"
      viewBox="0 0 9 9"
      shapeRendering="crispEdges"
      aria-hidden
      fill="currentColor"
    >
      <path d={d.join("")} />
    </svg>
  );
}

export function PixelBolt({ className }: { className?: string }) {
  const d = BOLT_RUNS.map(([x, y, w]) => `M${x} ${y}h${w}v1h-${w}z`).join("");
  return (
    <svg className={className} width="7" height="11" viewBox="0 0 7 11" shapeRendering="crispEdges" aria-hidden fill="currentColor">
      <path d={d} />
    </svg>
  );
}

/** A flat picture from runs of {x, y, width}, one pixel high each (the mod's TaskLook pictures). */
export function PixelRuns({
  runs,
  width,
  height,
  className,
  style,
}: {
  runs: ReadonlyArray<readonly [number, number, number]>;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}) {
  const d = runs.map(([x, y, w]) => `M${x} ${y}h${w}v1h-${w}z`).join("");
  return (
    <svg
      className={className}
      style={style}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden
      fill="currentColor"
    >
      <path d={d} />
    </svg>
  );
}

/** A task board's checklist icon, 7 x 8: a clipboard with two lines on it (the mod's TaskLook.CHECKLIST). */
export const CHECKLIST_RUNS: ReadonlyArray<readonly [number, number, number]> = [
  [2, 0, 3],
  [0, 1, 7],
  [0, 2, 1],
  [6, 2, 1],
  [0, 3, 1],
  [2, 3, 3],
  [6, 3, 1],
  [0, 4, 1],
  [6, 4, 1],
  [0, 5, 1],
  [2, 5, 3],
  [6, 5, 1],
  [0, 6, 1],
  [6, 6, 1],
  [0, 7, 7],
];

export function ChecklistIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <PixelRuns runs={CHECKLIST_RUNS} width={7} height={8} className={className} style={style} />
  );
}
