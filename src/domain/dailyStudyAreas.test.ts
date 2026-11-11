import { describe, expect, it } from "vitest";
import { createDailyAreaPlan, dailyAreaUnits, newWordBatchUnits, NEW_WORD_BATCH_SIZE } from "./dailyStudyAreas";
import { getEnglishPracticeCatalog } from "./englishPracticeCatalog";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore, isStudySession } from "../repository/schema";
import { initializeStudySession } from "../app/study/sessionInit";
import type { LearningItem, ScheduleState } from "./types";

const now = new Date("2026-10-13T02:00:00Z");
const item = (id: string, known = false): LearningItem => ({ id, language: "ja", type: "vocabulary", answer: `単語${id}`, reading: `たんご${id}`, promptZh: `詞義${id}`, source: "manual", tags: [], status: known ? "learning" : "new", createdAt: "2026-10-12T02:00:00.000Z", isSeed: false, ...(known ? { introducedAt: "2026-10-12T02:00:00.000Z" } : {}) });
const schedule = (i: LearningItem, ability: "recall" | "reading", future = false): ScheduleState => ({ learningItemId: i.id, language: i.language, ability, dueAt: future ? "2026-10-20T02:00:00.000Z" : "2026-10-12T02:00:00.000Z", intervalDays: 1, streak: 0, lapseCount: 0 });

describe("separate daily new-word and review areas", () => {
  it("arranges 50 distinct new words even with hundreds of overdue reviews; neither daily nor per-round budgets truncate review", () => {
    const known = Array.from({ length: 150 }, (_, n) => item(`known-${n}`, true));
    const fresh = Array.from({ length: 60 }, (_, n) => item(`new-${n}`));
    const schedules = known.flatMap(i => [schedule(i, "recall"), schedule(i, "reading")]);
    const plan = createDailyAreaPlan([...known, ...fresh], schedules, now);
    expect(plan.newItemIds).toHaveLength(50);
    expect(dailyAreaUnits(plan, "new")).toHaveLength(50);
    expect(dailyAreaUnits(plan, "review")).toHaveLength(300);
    const repository = new MemoryLearningRepository({ ...createEmptyStore(), items: [...known, ...fresh], scheduleStates: schedules });
    repository.saveDailyPlan(plan);
    const initialized = initializeStudySession(repository, now, 5, 50, plan, "ja", "review");
    expect(initialized.phase).toBe("active");
    if (initialized.phase !== "active") throw new Error("review session missing");
    expect(initialized.session.plannedUnits).toHaveLength(300);
    expect(initialized.session.plannedUnits.every(u => !plan.newItemIds.includes(u.learningItemId))).toBe(true);
    expect(isStudySession(initialized.session)).toBe(true);
    expect(repository.listScheduleStates()).toEqual(schedules);
    expect(repository.listReviewAttempts()).toEqual([]);
  });
  it("keeps future review out and includes missing reading abilities without consuming new-word quota", () => {
    const future = item("future", true), missingReading = item("missing-reading", true), paused = item("paused", true);
    paused.reviewPaused = true;
    const schedules = [schedule(future, "recall", true), schedule(future, "reading", true), schedule(missingReading, "recall", true), schedule(paused, "recall")];
    const plan = createDailyAreaPlan([future, missingReading, paused], schedules, now);
    expect(plan.newItemIds).toEqual([]);
    expect(dailyAreaUnits(plan, "review")).toEqual([expect.objectContaining({ learningItemId: missingReading.id, ability: "reading" })]);
  });
  it("preserves today's 50-word reservation and completed work when the plan is rebuilt", () => {
    const items = Array.from({ length: 70 }, (_, n) => item(`new-${n}`));
    const first = createDailyAreaPlan(items, [], now);
    first.completedUnitKeys = [`${first.newItemIds[0]}:recall`];
    items[0].introducedAt = now.toISOString();
    const schedules = [schedule(items[0], "recall", true)];
    const rebuilt = createDailyAreaPlan(items, schedules, now, first);
    expect(rebuilt.newItemIds).toEqual(first.newItemIds);
    expect(dailyAreaUnits(rebuilt, "new").some(u => u.learningItemId === items[0].id && u.ability === "recall")).toBe(false);
    expect(dailyAreaUnits(rebuilt, "new").some(u => u.learningItemId === items[0].id && u.ability === "reading")).toBe(true);
    expect(dailyAreaUnits(rebuilt, "review")).toEqual([]);
  });
  it("uses the same quota independently for English and keeps English new and review sessions separate", () => {
    const entry = getEnglishPracticeCatalog()[0];
    const english = Array.from({ length: 65 }, (_, n): LearningItem => ({ ...entry, id: `english-${n}`, status: "new", createdAt: now.toISOString(), isSeed: false }));
    const known: LearningItem = { ...english[0], id: "known-english", introducedAt: "2026-10-12T02:00:00.000Z" };
    const schedules: ScheduleState[] = [{ ...schedule(known, "recall"), ability: "meaning" }];
    const items = [item("japanese"), ...english, known];
    const plan = createDailyAreaPlan(items, schedules, now, undefined, [], "en");
    expect(plan.newItemIds).toHaveLength(50);
    expect(dailyAreaUnits(plan, "review").map(u => u.learningItemId)).toEqual([known.id]);
    const repo = new MemoryLearningRepository({ ...createEmptyStore(), items, scheduleStates: schedules });
    repo.saveDailyPlan(plan);
    const initialized = initializeStudySession(repo, now, 5, 50, plan, "en", "new");
    expect(initialized.phase).toBe("active");
    if (initialized.phase !== "active") throw new Error("new session missing");
    expect(initialized.session.plannedUnits).toHaveLength(NEW_WORD_BATCH_SIZE);
    expect(initialized.session.plannedUnits.every(u => u.ability === "meaning" && u.requiresIntroduction)).toBe(true);
    expect(initialized.session.plannedUnits.some(u => u.learningItemId === known.id)).toBe(false);
    const resumed = initializeStudySession(repo, now, 5, 50, plan, "en", "review");
    expect(resumed.phase === "active" && resumed.session.id).toBe(initialized.session.id);
  });
  it("shows empty review when only new words are available, and schedules actual content when fewer than 50 words exist", () => {
    const items = [item("one"), item("two")];
    const plan = createDailyAreaPlan(items, [], now);
    expect(plan.newItemIds).toHaveLength(2);
    expect(dailyAreaUnits(plan, "new")).toHaveLength(2);
    const repo = new MemoryLearningRepository({ ...createEmptyStore(), items });
    repo.saveDailyPlan(plan);
    expect(initializeStudySession(repo, now, 5, 50, plan, "ja", "review")).toEqual({ phase: "empty" });
  });
  it("limits the plan to the learner's own quota", () => {
    const items = Array.from({ length: 30 }, (_, n) => item(`new-${n}`));
    const plan = createDailyAreaPlan(items, [], now, undefined, [], "ja", 10);
    expect(plan.newItemCap).toBe(10);
    expect(plan.newItemIds).toHaveLength(10);
    expect(createDailyAreaPlan(items, [], now, undefined, [], "ja", 0).newItemIds).toEqual([]);
  });
  it("starts a new-word round with a few words and leaves the rest of the quota for later rounds", () => {
    const items = Array.from({ length: 30 }, (_, n) => item(`new-${n}`));
    const plan = createDailyAreaPlan(items, [], now, undefined, [], "ja", 20);
    const repo = new MemoryLearningRepository({ ...createEmptyStore(), items });
    repo.saveDailyPlan(plan);
    const initialized = initializeStudySession(repo, now, 5, 20, plan, "ja", "new");
    if (initialized.phase !== "active") throw new Error("new session missing");
    expect(initialized.session.plannedUnits.map(u => u.learningItemId)).toEqual(plan.newItemIds.slice(0, NEW_WORD_BATCH_SIZE));
    expect(dailyAreaUnits(plan, "new")).toHaveLength(20);
  });
  it("folds a short tail into the round so no round introduces fewer than four words", () => {
    const unit = (id: string, intro = true) => ({ learningItemId: id, ability: intro ? "recall" as const : "reading" as const, kind: "new" as const, requiresIntroduction: intro });
    const words = (count: number) => Array.from({ length: count }, (_, n) => unit(`w${n}`));
    expect(newWordBatchUnits(words(8))).toHaveLength(8);
    expect(newWordBatchUnits(words(9))).toHaveLength(5);
    expect(newWordBatchUnits(words(3))).toHaveLength(3);
  });
  it("finishes words already introduced today before adding unseen ones", () => {
    const unit = (id: string, intro: boolean) => ({ learningItemId: id, ability: intro ? "recall" as const : "reading" as const, kind: "new" as const, requiresIntroduction: intro });
    const units = [...Array.from({ length: 12 }, (_, n) => unit(`unseen-${n}`, true)), ...Array.from({ length: 7 }, (_, n) => unit(`started-${n}`, false))];
    const batch = newWordBatchUnits(units);
    expect(batch.filter(u => !u.requiresIntroduction).map(u => u.learningItemId)).toEqual(["started-0", "started-1", "started-2", "started-3", "started-4"]);
    expect(batch.filter(u => u.requiresIntroduction).map(u => u.learningItemId)).toEqual(["unseen-0", "unseen-1", "unseen-2", "unseen-3", "unseen-4"]);
  });
});
