import { describe, expect, it } from "vitest";
import { itemLevel, matchesLevels, parseJlptConceptKey } from "./jlptLevels";
import { getJlptPracticeCatalog, libraryEntryInput } from "./jlptPracticeCatalog";
import { selectMixedReviewUnits } from "./practiceSelection";
import { createDailyAreaPlan, dailyAreaUnits } from "./dailyStudyAreas";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore } from "../repository/schema";
import type { LearningItem } from "./types";

describe("JLPT level and question-type coordinates", () => {
  it("reads level, type and concept from a built-in concept key", () => {
    expect(parseJlptConceptKey("jlpt:n3:bunpou:wake-dewa-nai")).toEqual({ level: "N3", type: "bunpou", concept: "wake-dewa-nai" });
    expect(parseJlptConceptKey("jlpt:n5:goi:word:毎朝")).toEqual({ level: "N5", type: "goi", concept: "word:毎朝" });
  });
  it("rejects keys outside the convention instead of guessing", () => {
    for (const key of ["form:te", "jlpt:n1:bunpou:x", "jlpt:n4:listening:x", "jlpt:n4:bunpou", "word-form:食べる:te"])
      expect(parseJlptConceptKey(key), key).toBeUndefined();
  });
  it("levels practice content by concept key and words by tag", () => {
    const practice = getJlptPracticeCatalog().find(entry => entry.practice.conceptKey.startsWith("jlpt:n4:"))!.practice;
    expect(itemLevel({ practice, tags: ["N5"] })).toBe("N4");
    expect(itemLevel({ tags: ["名詞", "n3"] })).toBe("N3");
    expect(itemLevel({ tags: ["名詞"] })).toBeUndefined();
  });
  it("treats an empty selection as everything and keeps unlevelled words in their own group", () => {
    const untagged = { tags: [] }, n4 = { tags: ["N4"] };
    expect(matchesLevels(untagged, [])).toBe(true);
    expect(matchesLevels(untagged, ["N4"])).toBe(false);
    expect(matchesLevels(untagged, ["N4", "unleveled"])).toBe(true);
    expect(matchesLevels(n4, ["N4"])).toBe(true);
    expect(matchesLevels(n4, ["N5", "unleveled"])).toBe(false);
  });
});

describe("choosing review levels and switching on library content", () => {
  const now = new Date("2026-11-12T02:00:00Z");
  const catalog = getJlptPracticeCatalog();
  const pick = (level: string, type: string) => catalog.find(entry => entry.practice.conceptKey.startsWith(`jlpt:${level}:${type}:`))!;
  const word = (id: string, tags: string[] = []): LearningItem => ({ id, language: "ja", type: "vocabulary", answer: `単語${id}`, reading: `たんご${id}`, promptZh: `詞義${id}`, source: "manual", tags, status: "learning", createdAt: now.toISOString(), isSeed: false, introducedAt: now.toISOString() });
  const setup = () => {
    const repository = new MemoryLearningRepository({ ...createEmptyStore(), items: [word("plain"), word("tagged", ["N4"])] });
    repository.addItemsIfMissing([pick("n5", "bunpou"), pick("n4", "bunpou"), pick("n4", "dokkai")].map(libraryEntryInput));
    return repository;
  };

  it("adds a concept switched on, tagged with its level, and only once", () => {
    const repository = setup();
    const added = repository.listItems({ language: "ja" }).filter(item => item.practice);
    expect(added).toHaveLength(3);
    expect(added.every(item => item.practice!.learned && item.practice!.enabled)).toBe(true);
    expect(added.map(item => item.tags.at(-1)).sort()).toEqual(["N4", "N4", "N5"]);
    expect(repository.addItemsIfMissing([libraryEntryInput(pick("n5", "bunpou"))])).toEqual([]);
    expect(repository.listScheduleStates()).toEqual([]);
    expect(repository.listReviewAttempts()).toEqual([]);
  });
  it("restricts self-directed review to the chosen levels", () => {
    const items = setup().listItems({ language: "ja" });
    const levelsOf = (chosen: Parameters<typeof matchesLevels>[1]) =>
      selectMixedReviewUnits(items.filter(item => matchesLevels(item, chosen)), [], [], 100, now, () => 0.5).units
        .map(unit => itemLevel(items.find(item => item.id === unit.learningItemId)!) ?? "unleveled");
    expect(new Set(levelsOf(["N4"]))).toEqual(new Set(["N4"]));
    expect(new Set(levelsOf(["N5", "unleveled"]))).toEqual(new Set(["N5", "unleveled"]));
    expect(new Set(levelsOf([]))).toEqual(new Set(["N5", "N4", "unleveled"]));
  });
  it("leaves scheduled daily review untouched by the level choice", () => {
    const repository = setup();
    const items = repository.listItems({ language: "ja" });
    const plan = createDailyAreaPlan(items, [], now, undefined, [], "ja", 10);
    // The daily plan is built from every item; nothing in it reads the review-level preference.
    expect(new Set(dailyAreaUnits(plan, "review").map(unit => itemLevel(items.find(item => item.id === unit.learningItemId)!)))).toEqual(new Set(["N5", "N4", undefined]));
  });
});
