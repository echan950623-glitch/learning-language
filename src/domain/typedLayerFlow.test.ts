import { describe, expect, it } from "vitest";
import { getJlptPracticeCatalog, libraryEntryInput } from "./jlptPracticeCatalog";
import { productionEntries, type ProductionRow } from "./jlptProductionCatalog";
import { selectMixedReviewUnits } from "./practiceSelection";
import { createDailyAreaPlan, dailyAreaUnits } from "./dailyStudyAreas";
import { isLearningPractice } from "./learningPractice";
import { practiceChoices } from "./practicePresentation";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore } from "../repository/schema";

const now = new Date("2026-11-12T02:00:00Z");
const key = "jlpt:n4:bunpou:experience";
const recognition = getJlptPracticeCatalog().find(entry => entry.practice.conceptKey === key && entry.practice.capability === "recognition")!;
const rows: ProductionRow[] = [
  ["昨日、初めて京都へ（　）。", "行きました", ["いきました"], "填入「行く」的禮貌過去形", "過去的一次行為用ます形的過去。"],
  ["富士山に（　）ことがあります。", "登った", ["のぼった"], "填入「登る」的た形", "經驗用た形＋ことがある。"],
  ["寿司を（　）ことがありません。", "食べた", ["たべた"], "填入「食べる」的た形", "否定經驗是た形＋ことがありません。"],
];
const [typed] = productionEntries([recognition], { [key]: rows });

function enabled() {
  const repository = new MemoryLearningRepository(createEmptyStore());
  repository.addItemsIfMissing([recognition, typed].map(libraryEntryInput));
  return repository;
}
const select = (repository: MemoryLearningRepository) => selectMixedReviewUnits(repository.listItems({ language: "ja" }), [], [], 20, now, () => 0.5).units;

describe("typed layer of a grammar concept", () => {
  it("builds a valid typed entry that shares the concept and asks for typing", () => {
    expect(isLearningPractice(typed.practice)).toBe(true);
    expect(typed.practice.conceptKey).toBe(key);
    expect(typed.practice.capability).toBe("production");
    expect(typed.id).toBe(`${key}:production`);
    expect(typed.practice.variants).toHaveLength(3);
    const repository = enabled();
    const item = repository.listItems({ language: "ja" }).find(candidate => candidate.practice?.capability === "production")!;
    expect(practiceChoices({ ...item, promptZh: rows[0][0], practice: { ...item.practice!, activeVariantId: "typed-1" } })).toEqual([]);
  });

  it("adds both layers once, with a single card and no second introduction", () => {
    const repository = enabled();
    const items = repository.listItems({ language: "ja" });
    expect(items).toHaveLength(2);
    const [choice, typedItem] = [items.find(i => i.practice?.capability === "recognition")!, items.find(i => i.practice?.capability === "production")!];
    expect(choice.needsUnderstanding).toBe(true);
    expect(typedItem.needsUnderstanding).toBeUndefined();
    expect(typedItem.introducedAt).toBeDefined();
    expect(repository.addItemsIfMissing([recognition, typed].map(libraryEntryInput))).toEqual([]);
  });

  it("holds the typed questions back until the concept card has been seen", () => {
    const repository = enabled();
    const items = repository.listItems({ language: "ja" });
    const typedItem = items.find(i => i.practice?.capability === "production")!;
    expect(select(repository).map(unit => unit.learningItemId)).toEqual([items.find(i => i.practice?.capability === "recognition")!.id]);
    expect(dailyAreaUnits(createDailyAreaPlan(items, [], now, undefined, [], "ja", 5), "review").map(unit => unit.learningItemId)).not.toContain(typedItem.id);
    const [first] = select(repository);
    const session = repository.getOrCreateInProgressSession("ja", [first], now, { mode: "full" });
    repository.acknowledgeIntroduction(session.id, first.learningItemId, now);
    repository.abandonSession(session.id);
    expect(select(repository).map(unit => unit.learningItemId).sort()).toEqual(items.map(i => i.id).sort());
  });

  it("adds only the typed layer when the choice layer is already in the account", () => {
    const repository = new MemoryLearningRepository(createEmptyStore());
    repository.addItemsIfMissing([libraryEntryInput(recognition)]);
    const added = repository.addItemsIfMissing([recognition, typed].map(libraryEntryInput));
    expect(added.map(item => item.practice?.capability)).toEqual(["production"]);
  });
});
