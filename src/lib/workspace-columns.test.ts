// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  BOARD_MIN_WIDTH,
  ITEMS_DEFAULT_WIDTH,
  ITEMS_MAX_WIDTH,
  ITEMS_MIN_WIDTH,
  OVERVIEW_DEFAULT_WIDTH,
  OVERVIEW_MAX_WIDTH,
  OVERVIEW_MIN_WIDTH,
  PANEL_RAIL_WIDTH,
  clampItemsWidth,
  clampOverviewWidth,
  fitPanels,
  overlayInsets,
  panelDragLimits,
  planColumns,
  type PanelFitInput,
} from "./workspace-columns";

const open = (width: number) => ({ open: true, forced: false, width });
const wide = (over: Partial<PanelFitInput> = {}): PanelFitInput => ({
  width: 1641,
  items: open(ITEMS_DEFAULT_WIDTH),
  overview: open(OVERVIEW_DEFAULT_WIDTH),
  ...over,
});

describe("the side columns' limits", () => {
  it("the overview goes down to two thirds of its default, the items list down to three item columns", () => {
    expect(OVERVIEW_MIN_WIDTH).toBe(Math.round((OVERVIEW_DEFAULT_WIDTH * 2) / 3));
    expect(ITEMS_MIN_WIDTH).toBe(12 + 3 * 32);
  });

  it("holds a width to them, and a value that is no number to the default", () => {
    expect(clampOverviewWidth(100)).toBe(OVERVIEW_MIN_WIDTH);
    expect(clampOverviewWidth(5000)).toBe(OVERVIEW_MAX_WIDTH);
    expect(clampOverviewWidth(301.4)).toBe(301);
    expect(clampOverviewWidth(Number.NaN)).toBe(OVERVIEW_DEFAULT_WIDTH);
    expect(clampItemsWidth(10)).toBe(ITEMS_MIN_WIDTH);
    expect(clampItemsWidth(5000)).toBe(ITEMS_MAX_WIDTH);
    expect(clampItemsWidth(Number.POSITIVE_INFINITY)).toBe(ITEMS_DEFAULT_WIDTH);
  });
});

describe("fitPanels: a wide window", () => {
  it("gives both columns the width the player set, and the board the rest", () => {
    const fit = fitPanels(wide());
    expect(fit).toMatchObject({ itemsOpen: true, overviewOpen: true, itemsPx: 256, overviewPx: 336, boardPx: 1641 - 256 - 336 });
    expect(fit.itemsAutoFolded || fit.overviewAutoFolded).toBe(false);
  });

  it("follows what the player dragged", () => {
    const fit = fitPanels(wide({ items: open(180), overview: open(400) }));
    expect([fit.itemsPx, fit.overviewPx]).toEqual([180, 400]);
  });

  it("holds a stored width to the limits, and a folded column is its strip", () => {
    expect(fitPanels(wide({ items: open(9999) })).itemsPx).toBe(ITEMS_MAX_WIDTH);
    const folded = fitPanels(wide({ items: { open: false, forced: false, width: 300 } }));
    expect([folded.itemsOpen, folded.itemsPx, folded.itemsAutoFolded]).toEqual([false, PANEL_RAIL_WIDTH, false]);
  });
});

describe("fitPanels: the window narrows, the columns give way before the board", () => {
  // At 842 (Large on a 1280 window) the defaults leave a board of 250.
  it("the board keeps its least by the columns shrinking toward their own", () => {
    const fit = fitPanels(wide({ width: 900 }));
    expect(fit.boardPx).toBe(BOARD_MIN_WIDTH);
    expect(fit.itemsPx).toBeGreaterThanOrEqual(ITEMS_MIN_WIDTH);
    expect(fit.itemsPx).toBeLessThan(ITEMS_DEFAULT_WIDTH);
    expect(fit.overviewPx).toBeGreaterThanOrEqual(OVERVIEW_MIN_WIDTH);
    expect(fit.overviewPx).toBeLessThan(OVERVIEW_DEFAULT_WIDTH);
    expect(fit.itemsOpen && fit.overviewOpen).toBe(true);
  });

  it("they shrink in proportion to what they have over their least", () => {
    const fit = fitPanels(wide({ width: 1000 }));
    const cutItems = ITEMS_DEFAULT_WIDTH - fit.itemsPx;
    const cutOverview = OVERVIEW_DEFAULT_WIDTH - fit.overviewPx;
    expect(cutItems + cutOverview).toBe(ITEMS_DEFAULT_WIDTH + OVERVIEW_DEFAULT_WIDTH - (1000 - BOARD_MIN_WIDTH));
    const slackItems = ITEMS_DEFAULT_WIDTH - ITEMS_MIN_WIDTH;
    const slackOverview = OVERVIEW_DEFAULT_WIDTH - OVERVIEW_MIN_WIDTH;
    expect(Math.abs(cutItems / slackItems - cutOverview / slackOverview)).toBeLessThan(0.02);
  });

  it("the board is never under its least while a column can still give way", () => {
    for (let width = 2000; width >= BOARD_MIN_WIDTH + PANEL_RAIL_WIDTH * 2; width--) {
      const fit = fitPanels(wide({ width }));
      expect(fit.boardPx, `${width}`).toBeGreaterThanOrEqual(BOARD_MIN_WIDTH);
      expect(fit.itemsPx + fit.overviewPx + fit.boardPx).toBe(width);
    }
  });

  it("the items list folds to its strip once both columns are at their least and the board is still short", () => {
    const at = ITEMS_MIN_WIDTH + OVERVIEW_MIN_WIDTH + BOARD_MIN_WIDTH;
    const fits = fitPanels(wide({ width: at }));
    expect([fits.itemsOpen, fits.itemsPx, fits.overviewPx]).toEqual([true, ITEMS_MIN_WIDTH, OVERVIEW_MIN_WIDTH]);
    const short = fitPanels(wide({ width: at - 1 }));
    expect(short.itemsOpen).toBe(false);
    expect(short.itemsPx).toBe(PANEL_RAIL_WIDTH);
    expect(short.itemsAutoFolded).toBe(true);
    // What it gave goes back: the overview grows again toward the width the player set.
    expect(short.overviewPx).toBeGreaterThan(OVERVIEW_MIN_WIDTH);
    expect(short.boardPx).toBe(BOARD_MIN_WIDTH);
    expect(short.overviewOpen).toBe(true);
  });

  it("then the overview folds as well", () => {
    const at = OVERVIEW_MIN_WIDTH + PANEL_RAIL_WIDTH + BOARD_MIN_WIDTH;
    expect(fitPanels(wide({ width: at })).overviewOpen).toBe(true);
    const short = fitPanels(wide({ width: at - 1 }));
    expect([short.itemsOpen, short.overviewOpen]).toEqual([false, false]);
    expect([short.itemsAutoFolded, short.overviewAutoFolded]).toEqual([true, true]);
    expect(short.boardPx).toBe(at - 1 - PANEL_RAIL_WIDTH * 2);
  });

  it("folds in that order and unfolds in the reverse as the window widens", () => {
    const states: string[] = [];
    for (let width = 1600; width >= 500; width -= 5) {
      const fit = fitPanels(wide({ width }));
      states.push(`${fit.itemsOpen ? "I" : "i"}${fit.overviewOpen ? "O" : "o"}`);
    }
    const stretches = states.filter((state, at) => at === 0 || state !== states[at - 1]);
    expect(stretches).toEqual(["IO", "iO", "io"]);
  });

  it("is the same answer going either way: no history, so nothing flickers at an edge", () => {
    for (const width of [1200, 900, 800, 700, 600]) {
      expect(fitPanels(wide({ width }))).toEqual(fitPanels(wide({ width })));
    }
  });
});

describe("fitPanels: the player's own fold is never overwritten", () => {
  it("a column the player folded stays folded whatever the window does", () => {
    const itemsFolded = { open: false, forced: false, width: ITEMS_DEFAULT_WIDTH };
    for (const width of [2000, 900, 700]) {
      const fit = fitPanels(wide({ width, items: itemsFolded }));
      expect([fit.itemsOpen, fit.itemsAutoFolded]).toEqual([false, false]);
    }
  });

  it("a column the window folded comes back when the window widens", () => {
    expect(fitPanels(wide({ width: 700 })).itemsAutoFolded).toBe(true);
    expect(fitPanels(wide({ width: 1400 })).itemsOpen).toBe(true);
  });

  it("opened against the window, the items list stays and the overview folds in its place", () => {
    const width = ITEMS_MIN_WIDTH + OVERVIEW_MIN_WIDTH + BOARD_MIN_WIDTH - 1;
    const fit = fitPanels(wide({ width, items: { open: true, forced: true, width: ITEMS_DEFAULT_WIDTH } }));
    expect([fit.itemsOpen, fit.overviewOpen, fit.overviewAutoFolded]).toEqual([true, false, true]);
    expect(fit.boardPx).toBeGreaterThanOrEqual(BOARD_MIN_WIDTH);
  });

  it("opened against the window, the overview stays and the items list folds, as it would have anyway", () => {
    const width = ITEMS_MIN_WIDTH + OVERVIEW_MIN_WIDTH + BOARD_MIN_WIDTH - 1;
    const fit = fitPanels(wide({ width, overview: { open: true, forced: true, width: OVERVIEW_DEFAULT_WIDTH } }));
    expect([fit.itemsOpen, fit.overviewOpen]).toEqual([false, true]);
  });

  it("with both opened against the window the board takes what is left", () => {
    const width = 700;
    const fit = fitPanels({
      width,
      items: { open: true, forced: true, width: ITEMS_DEFAULT_WIDTH },
      overview: { open: true, forced: true, width: OVERVIEW_DEFAULT_WIDTH },
    });
    expect([fit.itemsOpen, fit.overviewOpen]).toEqual([true, true]);
    expect([fit.itemsPx, fit.overviewPx]).toEqual([ITEMS_MIN_WIDTH, OVERVIEW_MIN_WIDTH]);
    expect(fit.boardPx).toBe(width - ITEMS_MIN_WIDTH - OVERVIEW_MIN_WIDTH);
  });
});

describe("fitPanels: under a covering page", () => {
  it("the overview is gone, not folded, and the items list fits alone", () => {
    const fit = fitPanels(wide({ overview: null }));
    expect([fit.overviewPx, fit.overviewOpen, fit.overviewAutoFolded]).toEqual([0, false, false]);
    expect([fit.itemsPx, fit.boardPx]).toEqual([256, 1641 - 256]);
  });

  it("a narrow window shrinks it, then folds it", () => {
    expect(fitPanels(wide({ width: BOARD_MIN_WIDTH + 150, overview: null })).itemsPx).toBe(150);
    const short = fitPanels(wide({ width: BOARD_MIN_WIDTH + ITEMS_MIN_WIDTH - 1, overview: null }));
    expect([short.itemsOpen, short.itemsPx]).toEqual([false, PANEL_RAIL_WIDTH]);
  });
});

describe("panelDragLimits", () => {
  it("is the column's own limits while the window has room", () => {
    const fit = fitPanels(wide());
    expect(panelDragLimits("items", fit, 1641)).toEqual({ min: ITEMS_MIN_WIDTH, max: ITEMS_MAX_WIDTH });
    expect(panelDragLimits("overview", fit, 1641)).toEqual({ min: OVERVIEW_MIN_WIDTH, max: OVERVIEW_MAX_WIDTH });
  });

  it("stops where the board would fall under its least beside the other column as it is", () => {
    const width = 1000;
    const fit = fitPanels(wide({ width }));
    const { max } = panelDragLimits("overview", fit, width);
    expect(max).toBe(width - BOARD_MIN_WIDTH - fit.itemsPx);
    expect(width - max - fit.itemsPx).toBe(BOARD_MIN_WIDTH);
  });

  it("never goes under the column's least", () => {
    const fit = fitPanels(wide({ width: 600 }));
    expect(panelDragLimits("items", fit, 600).max).toBeGreaterThanOrEqual(ITEMS_MIN_WIDTH);
  });
});

describe("planColumns", () => {
  const fit = fitPanels(wide({ width: 1641 }));

  it("the overview on the left and the items list on the right", () => {
    expect(planColumns(fit, false)).toMatchObject({ itemsSide: "right", leftPx: 336, rightPx: 256, template: "336px minmax(0,1fr) 256px" });
  });

  it("or the other way round (Settings, Item browser)", () => {
    expect(planColumns(fit, true)).toMatchObject({ itemsSide: "left", leftPx: 256, rightPx: 336, template: "256px minmax(0,1fr) 336px" });
  });

  it("folded columns are their strips, and a covering page leaves the overview 0", () => {
    const folded = fitPanels(wide({ items: { open: false, forced: false, width: 256 } }));
    expect(planColumns(folded, false).template).toBe("336px minmax(0,1fr) 26px");
    expect(planColumns(fitPanels(wide({ overview: null })), false).template).toBe("0px minmax(0,1fr) 256px");
  });
});

describe("overlayInsets", () => {
  it("falls back to the measured browser while no workspace is mounted", () => {
    document.body.innerHTML = "";
    expect(overlayInsets(1, () => 256)).toEqual({ left: 256, right: 0 });
  });

  it("leaves both columns bright", () => {
    document.body.innerHTML = "<main data-plan-layout data-items-side='right' data-left-px='234' data-right-px='256'></main>";
    expect(overlayInsets(1, () => 999)).toEqual({ left: 234, right: 256 });
  });

  it("plan compact measures the open items drawer", () => {
    document.body.innerHTML =
      "<main data-plan-layout data-items-side='right' data-left-px='0' data-right-px='0' data-compact='true'></main><aside data-help-anchor='browser'></aside>";
    const aside = document.querySelector("aside")!;
    aside.getBoundingClientRect = () => ({ width: 200 }) as DOMRect;
    expect(overlayInsets(2, () => 999)).toEqual({ left: 0, right: 100 });
  });
});
