import { describe, expect, it } from "vitest";
import {
  buildSearchVocabulary,
  buildTextSearchIndex,
  createTokenInterner,
  queryTextSearchIndex,
  resolveSearchPhases,
  searchCorrector,
} from "./text-index";
import {
  matchSearchEntry,
  parseSearchQuery,
  searchQueryMatches,
  singularizeSearchToken,
  splitSearchTokens,
  withSearchCorrections,
} from "./text-search";

function entry(displayName: string, id = "", tooltip: string[] = []) {
  return {
    nameText: displayName.toLowerCase(),
    name: splitSearchTokens(displayName),
    id: splitSearchTokens(id),
    text: splitSearchTokens(tooltip.join(" ")),
  };
}

const OAK_LOG = entry("Oak Log", "minecraft:log");
const STEEL_INGOT = entry("Steel Ingot", "gregtech:gt.metaitem.01@11305");
const STEEL_DUST = entry("Small Pile of Steel Dust", "gregtech:gt.metaitem.01@2305");
const CREOSOTE = entry("Creosote Oil", "creosote");

describe("what a typed word stands for", () => {
  it("finds the singular when the plural was typed", () => {
    // "oak logs" used to come back empty on a dataset full of Oak Log: the
    // matcher asked whether "log" contained "logs".
    expect(searchQueryMatches(parseSearchQuery("oak logs"), OAK_LOG)).toBe(true);
    expect(searchQueryMatches(parseSearchQuery("oak log"), OAK_LOG)).toBe(true);
  });

  it("handles the plurals that are not just a trailing s", () => {
    expect(singularizeSearchToken("berries")).toBe("berry");
    expect(singularizeSearchToken("boxes")).toBe("box");
    expect(singularizeSearchToken("logs")).toBe("log");
    expect(singularizeSearchToken("glass")).toBeUndefined();
    expect(singularizeSearchToken("gas")).toBeUndefined();
  });

  it("understands the nicknames the wiki uses", () => {
    const ebf = entry("Electric Blast Furnace", "gregtech:gt.blockmachines");
    expect(searchQueryMatches(parseSearchQuery("ebf"), ebf)).toBe(true);
    // The expansion only runs one way: a word of the full name must not start
    // matching things called "ebf".
    expect(searchQueryMatches(parseSearchQuery("electric"), entry("EBF Casing"))).toBe(false);
  });

  it("reaches related words, but scores them below the real thing", () => {
    const woodScore = matchSearchEntry(parseSearchQuery("wood"), entry("Oak Wood")) ?? 0;
    const logScore = matchSearchEntry(parseSearchQuery("wood"), OAK_LOG) ?? 0;
    expect(logScore).toBeGreaterThan(0);
    expect(woodScore).toBeGreaterThan(logScore);
  });

  it("ignores accents", () => {
    expect(searchQueryMatches(parseSearchQuery("creosote"), CREOSOTE)).toBe(true);
    expect(searchQueryMatches(parseSearchQuery("créosote"), CREOSOTE)).toBe(true);
  });
});

describe("which result comes first", () => {
  it("puts the exact name above one that merely starts with it", () => {
    const query = parseSearchQuery("steel");
    const steel = matchSearchEntry(query, entry("Steel")) ?? 0;
    const ingot = matchSearchEntry(query, STEEL_INGOT) ?? 0;
    const dust = matchSearchEntry(query, STEEL_DUST) ?? 0;
    expect(steel).toBeGreaterThan(ingot);
    expect(ingot).toBeGreaterThan(dust);
  });

  it("weighs a word in the name above the same word in a registry id", () => {
    const query = parseSearchQuery("log");
    const named = matchSearchEntry(query, entry("Oak Log", "minecraft:log")) ?? 0;
    const idOnly = matchSearchEntry(query, entry("Bark", "etfuturum:logstripped")) ?? 0;
    expect(named).toBeGreaterThan(idOnly);
    expect(idOnly).toBeGreaterThan(0);
  });

  it("requires every typed word, like every other search box", () => {
    expect(searchQueryMatches(parseSearchQuery("steel ingot"), STEEL_INGOT)).toBe(true);
    expect(searchQueryMatches(parseSearchQuery("steel plate"), STEEL_INGOT)).toBe(false);
  });

  it("matches nothing in particular when nothing was typed", () => {
    expect(matchSearchEntry(parseSearchQuery("   "), STEEL_INGOT)).toBe(0);
  });
});

describe("typos", () => {
  const vocabulary = buildSearchVocabulary([
    "Steel Ingot",
    "Creosote Oil",
    "Oak Log",
    "Vacuum Tube",
    "Naquadah",
  ]);
  const correct = (value: string) =>
    withSearchCorrections(parseSearchQuery(value), searchCorrector(vocabulary));

  it("stands in the word that was meant", () => {
    expect(searchQueryMatches(correct("vaccum tube"), entry("Vacuum Tube"))).toBe(true);
    expect(searchQueryMatches(correct("creosoet"), CREOSOTE)).toBe(true);
    expect(correct("vaccum").corrections[0]).toEqual({ from: "vaccum", to: "vacuum" });
  });

  it("leaves a half-typed word alone", () => {
    // "creo" is the start of a real word, not a mistake, so nothing is guessed.
    expect(correct("creo").corrections).toEqual([]);
    expect(searchQueryMatches(correct("creo"), CREOSOTE)).toBe(true);
  });

  it("splits two words that were run together", () => {
    expect(searchQueryMatches(correct("oaklog"), OAK_LOG)).toBe(true);
  });

  it("guesses nothing for a word that is already real", () => {
    expect(correct("naquadah").corrections).toEqual([]);
  });

  it("scores a corrected match below one that needed no correcting", () => {
    const typo = matchSearchEntry(correct("vaccum tube"), entry("Vacuum Tube")) ?? 0;
    const clean = matchSearchEntry(correct("vacuum tube"), entry("Vacuum Tube")) ?? 0;
    expect(clean).toBeGreaterThan(typo);
  });
});

describe("asking three times", () => {
  const NAMES = ["Steel Ingot", "Vacuum Tube", "Wafer", "Silicon Dust", "Oak Log"];
  const vocabulary = buildSearchVocabulary(NAMES);
  const entries = NAMES.map((name) => entry(name));
  const resolve = (value: string) =>
    resolveSearchPhases(parseSearchQuery(value), vocabulary, (query, options) =>
      entries
        .map((candidate, index) => ({ index, score: matchSearchEntry(query, candidate, options) }))
        .filter((match): match is { index: number; score: number } => match.score !== undefined),
    );

  it("stops at what was typed when that finds enough", () => {
    const resolved = resolve("steel");
    expect(resolved.phase).toBe("exact");
    expect(resolved.results).toHaveLength(1);
  });

  it("respells only when the strict reading came up short", () => {
    expect(resolve("vaccum").phase).toBe("corrected");
    expect(resolve("vaccum").results).toHaveLength(1);
  });

  it("falls back to some of the words when no entry has all of them", () => {
    const resolved = resolve("silicon wafer");
    expect(resolved.phase).toBe("partial");
    expect(resolved.results.map((match) => NAMES[match.index]).sort()).toEqual([
      "Silicon Dust",
      "Wafer",
    ]);
  });

  it("gives up rather than inventing a match", () => {
    const resolved = resolve("naquadah");
    expect(resolved.results).toEqual([]);
  });

  it("never loosens a single word into a part-match", () => {
    // One word is the whole query, so "some of the words" would mean "none of
    // them": there is nothing to loosen and an empty result is the honest one.
    expect(resolve("zzzzzz").phase).toBe("exact");
  });
});

describe("trigram narrowing", () => {
  const index = buildTextSearchIndex(["hydrogen sulfide", "oak log", "steel ingot"], [0, 1, 2]);

  it("keeps substring matches inside a word and refuses to cross words", () => {
    expect(queryTextSearchIndex(index, parseSearchQuery("ulfide"))).toContain(0);
    expect(queryTextSearchIndex(index, parseSearchQuery("nsu"))).not.toContain(0);
  });

  it("narrows on every spelling a word stands for, so a plural still finds it", () => {
    expect(queryTextSearchIndex(index, parseSearchQuery("logs"))).toContain(1);
  });

  it("cannot narrow on a word too short to have trigrams", () => {
    expect(queryTextSearchIndex(index, parseSearchQuery("ok"))).toBeUndefined();
  });

  it("says so when nothing can match", () => {
    expect(queryTextSearchIndex(index, parseSearchQuery("naquadah"))).toEqual([]);
  });
});

describe("one copy of each word", () => {
  it("keeps every word and its order, across every list it interns", () => {
    const intern = createTokenInterner();
    const first = ["steel", "plate", "steel"];
    expect(intern(first)).toBe(first);
    expect(first).toEqual(["steel", "plate", "steel"]);
    expect(intern(["plate", "ingot"])).toEqual(["plate", "ingot"]);
    expect(intern([])).toEqual([]);
  });

  it("leaves the index's words as the text splits them", () => {
    const index = buildTextSearchIndex(["Steel Plate", "steel ingot", "Plate"], [0, 1, 2]);
    expect(index.tokensByEntry).toEqual([["steel", "plate"], ["steel", "ingot"], ["plate"]]);
  });
});
