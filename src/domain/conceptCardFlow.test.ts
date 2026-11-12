import { describe, expect, it } from "vitest";
import { getJlptPracticeCatalog, libraryEntryInput } from "./jlptPracticeCatalog";
import { selectMixedReviewUnits } from "./practiceSelection";
import { createDailyAreaPlan, dailyAreaUnits } from "./dailyStudyAreas";
import { conceptCardFor } from "./conceptCardLookup";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore } from "../repository/schema";

const now = new Date("2026-11-12T02:00:00Z");
const catalog = getJlptPracticeCatalog();
const grammar = catalog.find(entry => entry.practice.conceptKey === "jlpt:n4:bunpou:experience")!;
const word = catalog.find(entry => entry.practice.conceptKey.includes(":goi:word:"))!;

function enabled() {
  const repository = new MemoryLearningRepository(createEmptyStore());
  const [item] = repository.addItemsIfMissing([libraryEntryInput(grammar)]);
  return { repository, item };
}

describe("concept cards for library content", () => {
  it("starts library content as introduced but not yet understood", () => {
    const { item } = enabled();
    expect(item.introducedAt).toBeDefined();
    expect(item.needsUnderstanding).toBe(true);
    expect(item.status).toBe("learning");
  });

  it("opens a self-directed round with the card and lets its questions follow without the fresh-recall wait", () => {
    const { repository, item } = enabled();
    const { units } = selectMixedReviewUnits(repository.listItems({ language: "ja" }), [], [], 10, now, () => 0.5);
    expect(units).toEqual([expect.objectContaining({ learningItemId: item.id, requiresIntroduction: true, itemVersion: 1 })]);
    const session = repository.getOrCreateInProgressSession("ja", units, now, { mode: "full" });
    const understood = repository.acknowledgeIntroduction(session.id, item.id, now);
    expect(understood.understoodItemIds).toEqual([item.id]);
    expect(understood.plannedUnits.every(unit => !unit.recallNotBefore)).toBe(true);
    expect(repository.listItems({ language: "ja" })[0].needsUnderstanding).toBe(false);
  });

  it("enrols the concept in the review schedule once it is answered", () => {
    const { repository, item } = enabled();
    const { units } = selectMixedReviewUnits(repository.listItems({ language: "ja" }), [], [], 10, now, () => 0.5);
    const session = repository.getOrCreateInProgressSession("ja", units, now, { mode: "full" });
    repository.acknowledgeIntroduction(session.id, item.id, now);
    repository.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability: "recall", exerciseId: "e1", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 1000, now });
    expect(repository.listScheduleStates({ language: "ja" })).toEqual([expect.objectContaining({ learningItemId: item.id, ability: "recall" })]);
    const later = selectMixedReviewUnits(repository.listItems({ language: "ja" }), repository.listReviewAttempts({ language: "ja" }), repository.listScheduleStates({ language: "ja" }), 10, now, () => 0.5);
    expect(later.units.every(unit => !unit.requiresIntroduction)).toBe(true);
  });

  it("shows the card in the daily review area without taking a new-word slot", () => {
    const { repository, item } = enabled();
    const plan = createDailyAreaPlan(repository.listItems({ language: "ja" }), [], now, undefined, [], "ja", 5);
    expect(plan.newItemIds).toEqual([]);
    expect(dailyAreaUnits(plan, "review")).toEqual([expect.objectContaining({ learningItemId: item.id, requiresIntroduction: true })]);
  });

  it("finds a written card for grammar and builds one for word packs", () => {
    const grammarView = conceptCardFor({ practice: grammar.practice })!;
    expect(grammarView.level).toBe("N4");
    expect(grammarView.title).not.toMatch(/^N4｜|^文法：/);
    expect(grammarView.card?.connection).toBeTruthy();
    const wordView = conceptCardFor({ practice: word.practice })!;
    expect(wordView.card?.examples).toHaveLength(1);
    expect(conceptCardFor({})).toBeUndefined();
  });
});
