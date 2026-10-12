import { describe, expect, it } from "vitest";
import { getEnglishPracticeCatalog } from "./englishPracticeCatalog";
import { learnedEnglishPracticeItems, selectEnglishPracticeUnits } from "./englishPracticeSelection";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import type { LearningItem, ReviewAttempt, ScheduleState } from "./types";

const now = new Date("2026-10-12T08:00:00Z");
const catalog = getEnglishPracticeCatalog();
const make = (index: number, extra: Partial<LearningItem> = {}): LearningItem => ({
  ...catalog[index], id: `en-${index}`, createdAt: now.toISOString(), isSeed: false, status: "learning", introducedAt: now.toISOString(), ...extra,
});
const schedule = (item: LearningItem, dueAt: string): ScheduleState => ({ learningItemId: item.id, language: "en", ability: "meaning", dueAt, intervalDays: 1, streak: 0, lapseCount: 0 });
const attempt = (item: LearningItem, result: ReviewAttempt["result"], reviewedAt: string): ReviewAttempt => ({ id: `${item.id}-${reviewedAt}`, learningItemId: item.id, language: "en", exerciseId: "e", exerciseType: "meaning", sessionId: "s", result, reviewedAt, usedHint: false, responseTimeMs: 100 });

describe("English practice topic selection", () => {
  it("separates words from phrases and collocations, and keeps TOEIC empty even for workplace tags", () => {
    const items = [make(0), make(7), make(20), make(23)];
    expect(learnedEnglishPracticeItems(items, [], [], "vocabulary").map(i => i.id)).toEqual(["en-0", "en-7"]);
    expect(learnedEnglishPracticeItems(items, [], [], "phrase").map(i => i.id)).toEqual(["en-20", "en-23"]);
    expect(selectEnglishPracticeUnits(items, [], [], { category: "toeic", source: "all", questionCount: 10 }, now).units).toEqual([]);
  });
  it("excludes paused, archived, unsupported, unseen and Japanese items without losing previously studied content", () => {
    const known = make(0, { introducedAt: undefined });
    const items = [known, make(1, { reviewPaused: true }), make(2, { archivedAt: now.toISOString() }), make(3, { englishPractice: undefined }), make(4, { introducedAt: undefined }), make(5, { language: "ja" })];
    expect(learnedEnglishPracticeItems(items, [attempt(known, "incorrect", now.toISOString())], [], "vocabulary").map(i => i.id)).toEqual([known.id]);
    expect(learnedEnglishPracticeItems([known], [], [schedule(known, now.toISOString())], "vocabulary")).toEqual([known]);
    expect(learnedEnglishPracticeItems([known], [{ ...attempt(known, "incorrect", now.toISOString()), language: "ja" }], [], "vocabulary")).toEqual([]);
  });
  it("only selects due items within the chosen topic and respects the question count", () => {
    const items = [make(0), make(1), make(2), make(20)];
    const schedules = [schedule(items[0], "2026-10-10T08:00:00Z"), schedule(items[1], "2026-10-11T08:00:00Z"), schedule(items[2], "2026-10-20T08:00:00Z"), schedule(items[3], "2026-10-09T08:00:00Z")];
    const before = structuredClone(schedules);
    const selected = selectEnglishPracticeUnits(items, [], schedules, { category: "vocabulary", source: "due", questionCount: 1 }, now);
    expect(selected.total).toBe(2);
    expect(selected.units).toEqual([{ learningItemId: items[0].id, ability: "meaning", kind: "review" }]);
    expect(schedules).toEqual(before);
  });
  it("removes corrected items from wrong-answer practice and prioritizes due review", () => {
    const items = [make(0), make(1), make(2)];
    const attempts = [attempt(items[0], "incorrect", "2026-10-10T08:00:00Z"), attempt(items[0], "correct", "2026-10-11T08:00:00Z"), attempt(items[1], "incorrect", "2026-10-11T08:00:00Z")];
    const wrong = selectEnglishPracticeUnits(items, attempts, [], { category: "vocabulary", source: "wrong", questionCount: 10 }, now);
    expect(wrong.mode).toBe("wrong");
    expect(wrong.units.map(u => u.learningItemId)).toEqual([items[1].id]);
    const recommended = selectEnglishPracticeUnits(items, attempts, [schedule(items[2], "2026-10-10T08:00:00Z")], { category: "vocabulary", source: "recommended", questionCount: 1 }, now);
    expect(recommended.units[0].learningItemId).toBe(items[2].id);
  });
  it("creates a frozen English topic session, resumes it across topic changes, and leaves Japanese sessions and schedules intact", () => {
    const repo = new MemoryLearningRepository();
    const word = repo.addItem(catalog[0]);
    const phrase = repo.addItem(catalog[20]);
    const ja = repo.addItem({ language: "ja", type: "vocabulary", answer: "猫", promptZh: "貓", source: "manual", tags: [] });
    const japanese = repo.getOrCreateInProgressSession("ja", [{ learningItemId: ja.id, ability: "recall", kind: "review" }], now, { mode: "full" });
    const items = [word, phrase].map(i => ({ ...i, introducedAt: now.toISOString() }));
    const words = selectEnglishPracticeUnits(items, [], [], { category: "vocabulary", source: "all", questionCount: 5 }, now);
    const english = repo.getOrCreateInProgressSession("en", words.units, now, { mode: words.mode });
    expect(english.plannedUnits.map(u => u.learningItemId)).toEqual([word.id]);
    expect(english.plannedUnits[0].itemSnapshot?.englishPractice?.activeVariantId).toBeTruthy();
    const phrases = selectEnglishPracticeUnits(items, [], [], { category: "phrase", source: "all", questionCount: 5 }, now);
    expect(repo.getOrCreateInProgressSession("en", phrases.units, now, { mode: phrases.mode })).toEqual(english);
    expect(repo.getInProgressSession("ja")).toEqual(japanese);
    expect(repo.listScheduleStates()).toEqual([]);
    expect(repo.listReviewAttempts()).toEqual([]);
  });
});
