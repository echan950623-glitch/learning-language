import { describe, expect, it } from "vitest";
import { getJapanesePracticeCatalog } from "./japanesePracticeCatalog";
import { buildJlptPreviewBatches, getJlptPracticeCatalog } from "./jlptPracticeCatalog";
import { freezePracticeQuestion, isLearningPractice, practiceInput } from "./learningPractice";
import { gradeAttempt } from "./grading";
import { choiceIsAssisted, practiceChoices } from "./practicePresentation";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { buildQuickQuizUnits } from "./practice";
import { learningItemToRow, rowToLearningItem } from "../repository/sync/outbox";
import type { LearningItem } from "./types";

describe("JLPT original content in the existing study loop", () => {
  it("registers distinct, valid content without pretending the learner has learned N4", () => {
    const full = getJapanesePracticeCatalog();
    expect(new Set(full.map(e => e.id)).size).toBe(full.length);
    const catalog = getJlptPracticeCatalog();
    for (const level of ["n5", "n4"]) {
      const entries = catalog.filter(e => e.practice.conceptKey.startsWith(`jlpt:${level}:`));
      expect(entries.length).toBeGreaterThan(20);
      for (const key of ["sentence-composition", "text-grammar", "reading-short", "reading-medium", "reading-information", "context-vocabulary", "paraphrase"])
        expect(entries.some(e => e.practice.conceptKey === `jlpt:${level}:${key}`)).toBe(true);
    }
    for (const entry of catalog) {
      expect(isLearningPractice(entry.practice), entry.id).toBe(true);
      expect(entry.practice.learned).toBe(false);
      expect(entry.practice.enabled).toBe(false);
      expect(entry.practice.capability).toBe("recognition");
      expect(entry.practice.variants.length).toBeGreaterThanOrEqual(3);
      expect(full.some(e => e.id === entry.id)).toBe(true);
    }
  });

  it("uses the authored four options, grades both text and original numbers, rejects every distractor", () => {
    for (const entry of getJlptPracticeCatalog()) {
      for (const variant of entry.practice.variants) {
        const item: LearningItem = { ...practiceInput({ ...structuredClone(entry.practice), activeVariantId: variant.id }), id: entry.id, status: "new", isSeed: false, createdAt: "2026-10-10T00:00:00Z" };
        const frozen = freezePracticeQuestion(item, []);
        // Test each specific variant, independent of first-session rotation.
        frozen.practice!.activeVariantId = variant.id;
        const original = structuredClone(frozen);
        const options = practiceChoices(frozen);
        expect(options, `${entry.id}/${variant.id}`).toEqual(variant.prompt.split("\n").slice(-4).map(line => line.slice(3)));
        expect(options).toHaveLength(4);
        const correct = options.indexOf(variant.answer);
        expect(correct).toBeGreaterThanOrEqual(0);
        for (const [i, option] of options.entries()) {
          for (const rawInput of [option, String(i + 1)]) {
            expect(gradeAttempt({ ability: "recall", rawInput, expectedAnswer: variant.answer, acceptedAnswers: variant.acceptedAnswers }).correct, `${entry.id}/${variant.id}: ${rawInput}`).toBe(i === correct);
          }
        }
        expect(choiceIsAssisted(frozen)).toBe(false);
        expect(frozen).toEqual(original);
      }
    }
  });

  it("makes bounded preview batches usable on the current MCP without auto-confirm or fake progress", () => {
    for (const level of ["N5", "N4"] as const) {
      const batches = buildJlptPreviewBatches(level, level === "N5");
      expect(batches.flatMap(b => b.items)).toHaveLength(getJlptPracticeCatalog().filter(e => e.practice.conceptKey.startsWith(`jlpt:${level.toLowerCase()}:`)).length);
      for (const batch of batches) {
        expect(batch.items.length).toBeGreaterThan(0);
        expect(batch.items.length).toBeLessThanOrEqual(20);
        expect(batch).not.toHaveProperty("confirm");
        for (const item of batch.items) {
          expect(item.learnedConfirmed).toBe(level === "N5");
          expect(item.practice.learned).toBe(false);
          expect(item.practice.enabled).toBe(false);
          expect(item.practice.activeVariantId).toBeUndefined();
        }
      }
    }
    const batches = buildJlptPreviewBatches("N4");
    batches[0].items[0].practice.variants[0].answer = "edited";
    expect(buildJlptPreviewBatches("N4")[0].items[0].practice.variants[0].answer).not.toBe("edited");
  });

  it("keeps new N4 out of quizzes and persists an N5 answer with a frozen JLPT question", () => {
    const repo = new MemoryLearningRepository();
    const catalog = getJlptPracticeCatalog();
    const n4 = repo.addItem(practiceInput(catalog.find(e => e.practice.conceptKey.startsWith("jlpt:n4:"))!.practice));
    const n5 = repo.addItem(practiceInput({ ...catalog.find(e => e.practice.conceptKey.startsWith("jlpt:n5:"))!.practice, learned: true, enabled: true }));
    expect(buildQuickQuizUnits(repo.listItems(), 10).every(u => u.learningItemId === n5.id)).toBe(true);
    expect(rowToLearningItem(learningItemToRow(n4, "owner"))).toEqual(n4);
    const now = new Date("2026-10-10T00:00:00Z");
    const session = repo.getOrCreateInProgressSession("ja", [{ learningItemId: n5.id, ability: "recall", kind: "review" }], now, { mode: "random" });
    const question = session.plannedUnits[0].itemSnapshot!;
    const result = repo.recordGradedAttempt({ sessionId: session.id, learningItemId: n5.id, ability: "recall", exerciseType: "recall", exerciseId: "jlpt-exercise", result: "correct", usedHint: false, responseTimeMs: 1000, rawAnswer: question.answer, normalizedAnswer: question.answer, now });
    expect(result.attempt.abilityEvidence?.question.practice?.conceptKey).toBe(n5.practice!.conceptKey);
    expect(result.attempt.abilityEvidence?.question.practice?.activeVariantId).toBeDefined();
    expect(repo.getScheduleState(n4.id, "recall")).toBeUndefined();
  });
});
