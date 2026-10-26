import type { useStoreApi } from "@xyflow/react";
import { useFactoryStore } from "@/store/factory-store";
import { drawMinimap, fitView, type MapView } from "./minimap-draw";
import { readMinimapRoutes } from "./minimap-feed";
import { getMinimap, MINIMAP_SIZES } from "./minimap-settings";
import { buildScene, type DrawerKind, type Scene, type SceneNode, type TileExtras } from "./minimap-scene";
import { currentFontEpoch } from "../text-measure";

/**
 * The map's frame loop, outside React: it listens to the board's own store, rebuilds the scene when nodes or
 * edges change (at most once a frame), and redraws when the camera moves. Nothing per frame touches the DOM but
 * the one canvas.
 */

type StoreApi = ReturnType<typeof useStoreApi>;

/** The least time between two rebuilds of the scene. */
const REBUILD_GAP_MS = 100;
/** A map of this many tiles redraws at most every DRAW_GAP_MS while the camera moves (1,500 tiles are 10 ms a draw). */
const BIG_MAP_TILES = 300;
const DRAW_GAP_MS = 40;
/** Where the map looks when there is no plan to fit. */
const FALLBACK_ZOOM = 0.09;

const IMAGE_CACHE = new Map<string, HTMLImageElement | "loading" | "failed">();

function urlOf(css: string): string | undefined {
  const m = /url\((?:"|')?([^"')]+)(?:"|')?\)/.exec(css);
  return m?.[1];
}

/** What a card's or drawer's own DOM carries that its node data does not: the picture, the drawer's role and rate. */
export function readExtras(
  root: Element | null,
  id: string,
  type: string | undefined,
  wrapperOf?: (id: string) => Element | null | undefined,
): TileExtras | undefined {
  if (!root) return undefined;
  const el = wrapperOf ? wrapperOf(id) : root.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return undefined;
  if (type === "recipeNode") {
    const glance = el.querySelector<HTMLElement>(".cc-glance");
    return { art: glance ? urlOf(glance.style.backgroundImage) : undefined };
  }
  if (type === "storageNode") {
    const cd = el.querySelector<HTMLElement>(".cd");
    const kind = cd?.dataset.kind as DrawerKind | undefined;
    const num = el.querySelector<HTMLElement>(".cd-num");
    const zero = num?.hasAttribute("data-zero");
    const icon = el.querySelector<HTMLElement>(".cd-icon");
    const img = icon?.querySelector("img");
    const art = img?.getAttribute("src") ?? (icon ? urlOf(icon.style.backgroundImage) : undefined);
    const text = num?.textContent?.trim();
    // Taken from a source, put into a product or trash; nothing signs what passes through a buffer.
    const sign = kind === "source" ? "-" : kind === "buffer" ? "" : "+";
    return {
      drawer: kind,
      art: art ?? undefined,
      rate: text && !zero ? `${sign}${text}` : undefined,
      label: el.querySelector(".cd-name")?.textContent ?? undefined,
    };
  }
  return undefined;
}

type Point = { x: number; y: number };

/**
 * Where the map looks and how far out. It never follows the board's camera: fitted (the default) it shows the whole
 * plan and only the view frame moves; zoomed by hand it holds its centre (the plan's middle at first) and moves only
 * when the board's view goes off the map, to bring it back. "Centre on the card you select" and a press carrying the
 * board come first.
 */
export function mapCamera(input: {
  fit: boolean;
  /** The hand zoom. */
  zoom: number;
  side: number;
  circle: boolean;
  bounds: { x0: number; y0: number; x1: number; y1: number } | undefined;
  viewRect: { x: number; y: number; w: number; h: number };
  anchor: Point | undefined;
  frozen: Point | undefined;
  selected: Point | undefined;
}): { cx: number; cy: number; zoom: number; anchor: Point | undefined; fitted: boolean } {
  const view = { x: input.viewRect.x + input.viewRect.w / 2, y: input.viewRect.y + input.viewRect.h / 2 };
  const fitted = input.fit ? fitView(input.bounds, input.side, input.circle) : undefined;
  if (fitted) {
    const at = input.selected ?? { x: fitted.cx, y: fitted.cy };
    return { cx: at.x, cy: at.y, zoom: fitted.zoom, anchor: undefined, fitted: true };
  }
  const zoom = input.zoom;
  if (input.frozen) return { cx: input.frozen.x, cy: input.frozen.y, zoom, anchor: input.anchor, fitted: false };
  if (input.selected) return { cx: input.selected.x, cy: input.selected.y, zoom, anchor: input.anchor, fitted: false };
  const b = input.bounds;
  let anchor = input.anchor ?? (b ? { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 } : view);
  const reach = (input.side / 2 - 4) / zoom;
  if (Math.abs(view.x - anchor.x) > reach || Math.abs(view.y - anchor.y) > reach) anchor = view;
  return { cx: anchor.x, cy: anchor.y, zoom, anchor, fitted: false };
}

/** Last frame costs, for checking the map stays cheap (window.__minimapStats in development). */
export const minimapStats: {
  rebuildMs: number;
  drawMs: number;
  tiles: number;
  rebuilds: number;
  draws: number;
  /** Where the map last looked (board px at its middle, map px per board px). */
  view?: { cx: number; cy: number; zoom: number };
} = { rebuildMs: 0, drawMs: 0, tiles: 0, rebuilds: 0, draws: 0 };

export class MinimapEngine {
  scene: Scene | undefined;
  view: MapView | undefined;
  /** While a press carries the board, the map holds still on this point. */
  frozen: { x: number; y: number } | undefined;
  /** Where a hand-zoomed map is centred; it moves only when the board's view leaves the map. */
  private anchor: { x: number; y: number } | undefined;
  private raf = 0;
  private dirty = { scene: true, draw: true };
  private extras = new Map<string, { data: unknown; extras: TileExtras | undefined }>();
  private routesSig = "";
  private stopped = false;
  /** The map's face, read once: asking for a computed style every frame would cost a style recalculation. */
  private font: string | undefined;
  private fontAt = -1;

  /** The canvas's face, read again when the font setting changes. */
  private fontFor(canvas: HTMLCanvasElement): string {
    const epoch = currentFontEpoch();
    if (this.font === undefined || this.fontAt !== epoch) {
      this.font = getComputedStyle(canvas).fontFamily || "monospace";
      this.fontAt = epoch;
    }
    return this.font;
  }
  private lastRebuildAt = -1000;
  private deferTimer = 0;
  private drawTimer = 0;
  private lastDrawAt = -1000;

  constructor(
    private readonly store: StoreApi,
    private readonly canvas: () => HTMLCanvasElement | null,
  ) {}

  schedule(what: "scene" | "draw"): void {
    if (this.stopped) return;
    if (what === "scene") this.dirty.scene = true;
    this.dirty.draw = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick());
  }

  /** Starts listening; returns the stop function. */
  start(): () => void {
    this.stopped = false;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __minimapStats?: object }).__minimapStats = minimapStats;
    this.schedule("scene");
    const unsubscribe = this.store.subscribe((state, prev) => {
      if (state.nodes !== prev.nodes || state.edges !== prev.edges || state.nodeLookup !== prev.nodeLookup) {
        this.schedule("scene");
      } else if (state.transform !== prev.transform || state.width !== prev.width || state.height !== prev.height) {
        this.schedule("draw");
      }
    });
    // New routes land after the nodes do: look again a few times a second while the map is up.
    const poll = window.setInterval(() => {
      const snapshot = readMinimapRoutes();
      if ((snapshot?.signature ?? "") !== this.routesSig) this.schedule("scene");
    }, 400);
    return () => {
      this.stopped = true;
      unsubscribe();
      window.clearInterval(poll);
      window.clearTimeout(this.deferTimer);
      window.clearTimeout(this.drawTimer);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    };
  }

  private rebuild(): void {
    const state = this.store.getState();
    const root = state.domNode ?? null;
    const nodes: SceneNode[] = [];
    for (const [id, node] of state.nodeLookup) {
      nodes.push({
        id,
        type: node.type,
        x: node.internals.positionAbsolute.x,
        y: node.internals.positionAbsolute.y,
        w: node.measured?.width ?? node.width ?? 0,
        h: node.measured?.height ?? node.height ?? 0,
        hidden: node.hidden,
        selected: node.selected,
        data: node.data,
      });
    }
    const cache = this.extras;
    // Every node's wrapper by id, read once in one pass when the first is wanted: a selector query per card was a
    // walk of the whole board each, 240 ms of a rebuild after a solve at 1,000 cards.
    let wrappers: Map<string, Element> | undefined;
    const wrapperOf = (id: string) => {
      if (!wrappers) {
        wrappers = new Map();
        for (const element of root?.querySelectorAll(".react-flow__node[data-id]") ?? []) {
          wrappers.set(element.getAttribute("data-id")!, element);
        }
      }
      return wrappers.get(id);
    };
    const extras = (id: string) => {
      const node = state.nodeLookup.get(id);
      if (!node) return undefined;
      const hit = cache.get(id);
      if (hit && hit.data === node.data) return hit.extras;
      const fresh = readExtras(root, id, node.type, wrapperOf);
      cache.set(id, { data: node.data, extras: fresh });
      return fresh;
    };
    const snapshot = readMinimapRoutes();
    this.routesSig = snapshot?.signature ?? "";
    this.scene = buildScene({
      name: useFactoryStore.getState().project.name ?? "",
      nodes,
      edges: state.edges as never,
      routes: snapshot?.routes,
      extras,
    });
  }

  private tick(): void {
    this.raf = 0;
    const canvas = this.canvas();
    if (!canvas || this.stopped) return;
    if (this.dirty.scene) {
      const t0 = performance.now();
      // A dragged card changes the nodes every frame; the map takes it at most ten times a second.
      if (t0 - this.lastRebuildAt < REBUILD_GAP_MS && this.scene) {
        if (!this.deferTimer) {
          this.deferTimer = window.setTimeout(() => {
            this.deferTimer = 0;
            this.schedule("draw");
          }, REBUILD_GAP_MS);
        }
      } else {
        this.lastRebuildAt = t0;
        this.dirty.scene = false;
        this.rebuild();
        minimapStats.rebuildMs = performance.now() - t0;
        minimapStats.rebuilds++;
        minimapStats.tiles = this.scene?.tiles.length ?? 0;
      }
    }
    if (!this.dirty.draw) return;
    const drawStart = performance.now();
    if ((this.scene?.tiles.length ?? 0) > BIG_MAP_TILES && drawStart - this.lastDrawAt < DRAW_GAP_MS) {
      // Still dirty: it is drawn when the gap is over, with the camera as it is then.
      if (!this.drawTimer) {
        this.drawTimer = window.setTimeout(() => {
          this.drawTimer = 0;
          this.schedule("draw");
        }, DRAW_GAP_MS - (drawStart - this.lastDrawAt));
      }
      return;
    }
    this.lastDrawAt = drawStart;
    this.dirty.draw = false;
    const state = this.store.getState();
    const [tx, ty, tz] = state.transform;
    const viewW = state.width / tz;
    const viewH = state.height / tz;
    const viewRect = { x: -tx / tz, y: -ty / tz, w: viewW, h: viewH };
    const cfg = getMinimap();
    const side = MINIMAP_SIZES[cfg.size];
    const circle = cfg.shape === "circle";
    const sel = cfg.follow ? this.scene?.tiles.find((t) => t.selected) : undefined;
    const camera = mapCamera({
      fit: true,
      zoom: FALLBACK_ZOOM,
      side,
      circle,
      bounds: this.scene?.bounds,
      viewRect,
      anchor: this.anchor,
      frozen: this.frozen,
      selected: sel ? { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 } : undefined,
    });
    this.anchor = camera.anchor;
    const { cx, cy } = camera;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(side * dpr);
    if (canvas.width !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const view: MapView = {
      cx,
      cy,
      zoom: camera.zoom,
      size: side,
      circle,
    };
    drawMinimap(ctx, this.scene, view, {
      font: this.fontFor(canvas),
      viewRect,
      image: (url) => {
        const hit = IMAGE_CACHE.get(url);
        if (hit instanceof HTMLImageElement) return hit;
        if (hit === undefined) {
          IMAGE_CACHE.set(url, "loading");
          const img = new Image();
          img.onload = () => {
            IMAGE_CACHE.set(url, img);
            this.schedule("draw");
          };
          img.onerror = () => IMAGE_CACHE.set(url, "failed");
          img.src = url;
        }
        return undefined;
      },
    });
    this.view = view;
    minimapStats.view = { cx: view.cx, cy: view.cy, zoom: view.zoom };
    minimapStats.drawMs = performance.now() - drawStart;
    minimapStats.draws++;
  }
}
