import { describe, expect, it } from "vitest";
import { MemoryLearningRepository } from "./memoryRepository";
import { createEmptyStore, sanitizeStore } from "./schema";
import { getJapanesePracticeCatalog } from "../domain/japanesePracticeCatalog";
import { practiceInput, practiceEvidence, spacePracticeUnits, isLearningPractice, isCoachReport, freezePracticeQuestion } from "../domain/learningPractice";
import { createDailyPlan } from "../domain/learningRules";
import { buildQuickQuizUnits, buildWrongAnswerUnits, buildFullReviewUnits } from "../domain/practice";
import { learningItemToRow, rowToLearningItem } from "./sync/outbox";
import { checkItemFieldsCompatible } from "./sync/duplicateItemResolution";
import { gradeAttempt } from "../domain/grading";
import type { StudySession, ReviewAttempt, ScheduleState } from "../domain/types";
const NOW = new Date("2026-10-07T04:00:00.000Z");
const catalog = getJapanesePracticeCatalog();
const input = (id = "form:te:production", learned = true) => practiceInput({ ...structuredClone(catalog.find(e => e.id === id)!.practice), learned, enabled: learned });
function snapshot(repo: MemoryLearningRepository) { return { ...createEmptyStore(), items: repo.listItems({ includeArchived: true, includeReports: true }), scheduleStates: repo.listScheduleStates(), reviewAttempts: repo.listReviewAttempts(), studySessions: repo.listStudySessions({ status: "all" }), dailyPlans: repo.listDailyPlans() }; }
function submit(repo: MemoryLearningRepository, session: StudySession, now: Date, usedHint = false, result = "correct" as "correct" | "incorrect") {
  const active = repo.listStudySessions({ status: "all" }).find(s => s.id === session.id)!;
  const unit = active.plannedUnits[active.exerciseResults.length];
  const answer = unit.itemSnapshot?.answer ?? "";
  return repo.recordGradedAttempt({ sessionId: session.id, learningItemId: unit.learningItemId, ability: unit.ability, exerciseType: unit.ability,
    exerciseId: `exercise-${now.toISOString()}-${active.exerciseResults.length}`, result, usedHint, responseTimeMs: 1000, rawAnswer: answer, normalizedAnswer: answer, now });
}
describe("practice integrates with the existing persisted learning loop", () => {
  it("never arranges unlearned or paused content in any mode", () => {
    const repo = new MemoryLearningRepository(); const unknown = repo.addItem(input(undefined, false));
    expect(createDailyPlan(repo.listItems(), [], NOW, 5).units).toEqual([]);
    expect(buildQuickQuizUnits(repo.listItems(), 10)).toEqual([]);
    expect(buildWrongAnswerUnits(repo.listItems(), [])).toEqual([]); expect(buildFullReviewUnits(repo.listItems(), [])).toEqual([]);
    expect(() => repo.getOrCreateInProgressSession("ja", [{ learningItemId: unknown.id, ability: "recall", kind: "review" }], NOW, { mode: "random" })).toThrow("尚未確認");
  });
  it("new content, variants, history and independent capability survive storage and row conversion", () => {
    const repo = new MemoryLearningRepository(); const production = repo.addItem(input()); const usage = repo.addItem(input("grammar:teiru:usage"));
    const plan = repo.saveDailyPlan(createDailyPlan(repo.listItems(), [], NOW, 5));
    const session = repo.getOrCreateInProgressSession("ja", plan.units, NOW, { mode: "today", dailyPlanId: plan.id });
    for (const id of plan.newItemIds) repo.acknowledgeIntroduction(session.id, id, NOW, true);
    const outcome = submit(repo, session, NOW);
    expect(outcome.attempt.abilityEvidence?.question.practice?.activeVariantId).toBeDefined();
    expect(repo.getScheduleState(usage.id, "recall")).toBeUndefined();
    const store = snapshot(repo); const sanitized = sanitizeStore(JSON.parse(JSON.stringify(store)));
    expect(sanitized.usedFallback).toBe(false); expect(sanitized.store).toEqual(store);
    expect(rowToLearningItem(learningItemToRow(production, "owner"))).toEqual(production);
  });
  it("rotates questions across sessions and maintains fixed snapshots during an edit", () => {
    const repo = new MemoryLearningRepository(); let item = repo.addItem(input());
    const session = repo.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], NOW, { mode: "random" });
    const first = session.plannedUnits[0].itemSnapshot!;
    submit(repo, session, NOW);
    const second = repo.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], new Date(NOW.getTime() + 86400000), { mode: "random" });
    expect(second.plannedUnits[0].itemSnapshot!.practice!.activeVariantId).not.toBe(first.practice!.activeVariantId);
    const edited = structuredClone(item.practice!); edited.variants[1].answer = "changed";
    item = repo.editItem(item.id, 1, { promptZh: item.promptZh, answer: item.answer, practice: edited }, NOW);
    const result = submit(repo, second, new Date(NOW.getTime() + 86400000));
    expect(result.attempt.abilityEvidence!.question.answer).not.toBe("changed");
    expect(item.contentVersion).toBe(2); expect(repo.listReviewAttempts()).toHaveLength(2);
    expect(repo.listScheduleStates()).toEqual([]);
  });
  it("no substring grading and accepts kana/alternate variants only when specified", () => {
    const practice = input().practice!; const first = practice.variants[0];
    expect(gradeAttempt({ ability: "recall", rawInput: "はらって", expectedAnswer: first.answer, acceptedAnswers: first.acceptedAnswers }).correct).toBe(true);
    expect(gradeAttempt({ ability: "recall", rawInput: "払っている", expectedAnswer: first.answer, acceptedAnswers: first.acceptedAnswers }).correct).toBe(false);
  });
  it("same concept variants are spaced when possible and primed success cannot advance schedules", () => {
    const repo = new MemoryLearningRepository();
    const recognition = repo.addItem(input("grammar:teiru:recognition")); const usage = repo.addItem(input("grammar:teiru:usage"));
    const other = [repo.addItem(input("form:nai:production")), repo.addItem(input("form:ta:production")), repo.addItem(input("form:potential:production"))];
    const units = [recognition, usage, ...other].map(item => ({ learningItemId: item.id, ability: "recall" as const, kind: "review" as const }));
    expect(spacePracticeUnits(units, repo.listItems()).map(u => u.learningItemId)).toEqual([recognition.id, ...other.map(i => i.id), usage.id]);
    const session = repo.getOrCreateInProgressSession("ja", units.slice(0, 2), NOW, { mode: "random" });
    submit(repo, session, NOW);
    expect(submit(repo, session, new Date(NOW.getTime() + 1000)).attempt.usedHint).toBe(true);
  });
  it("GPT reports stay outside queues, counts and formal attempts, but remain in backups", () => {
    const repo = new MemoryLearningRepository();
    const report = repo.addItem({ language: "ja", type: "phrase", promptZh: "教練摘要", answer: "report-1", source: "ai", tags: [], coachReport: {
      version: 1, externalId: "report-1", practicedAt: NOW.toISOString(), source: "gpt", summary: "有提示後完成て形", observations: [{ conceptKey: "form:te", capability: "production", observation: "需再驗證", assisted: true }] } });
    expect(repo.listItems()).toEqual([]); expect(repo.listItems({ includeReports: true })).toHaveLength(1);
    expect(buildQuickQuizUnits([report], 10)).toEqual([]); expect(repo.listReviewAttempts()).toEqual([]); expect(repo.listScheduleStates()).toEqual([]);
    expect(sanitizeStore(snapshot(repo)).usedFallback).toBe(false);
  });
  it("rejects incompatible duplicate metadata and undeclared sensitive fields", () => {
    const repo = new MemoryLearningRepository(); const item = repo.addItem(input()); const row = learningItemToRow(item, "owner");
    const different = structuredClone(row); different.learning_metadata!.practice!.variants[0].answer = "other";
    expect(checkItemFieldsCompatible(row, different).compatible).toBe(false);
    const reordered = structuredClone(row);
    reordered.learning_metadata!.practice = Object.fromEntries(Object.entries(reordered.learning_metadata!.practice!).reverse()) as typeof item.practice;
    expect(checkItemFieldsCompatible(row, reordered).compatible).toBe(true);
    expect(isLearningPractice({ ...item.practice, accessToken: "private" })).toBe(false);
    expect(isCoachReport({ version: 1, source: "gpt", externalId: "r", practicedAt: NOW.toISOString(), summary: "x", observations: [], secret: "private" })).toBe(false);
  });
  it("different forms of the same word cannot produce two independent recalls in a row", () => {
    const repo = new MemoryLearningRepository();
    const onlyOne = (id: string) => { const value = input(id); value.practice!.variants = value.practice!.variants.slice(0, 1); return value; };
    const te = repo.addItem(onlyOne("form:te:production")); const ta = repo.addItem(onlyOne("form:ta:production"));
    const session = repo.getOrCreateInProgressSession("ja", [te, ta].map(i => ({ learningItemId: i.id, ability: "recall", kind: "review" })), NOW, { mode: "random" });
    submit(repo, session, NOW);
    expect(submit(repo, session, new Date(NOW.getTime() + 1000)).attempt.usedHint).toBe(true);
  });
  it("diversifies conjugation words and prioritizes confirmed prior learning within the shared daily cap", () => {
    const repo = new MemoryLearningRepository();
    repo.addItem({ language: "ja", type: "vocabulary", promptZh: "新字", answer: "新語", source: "manual", tags: [] });
    const te = repo.addItem(input()); const ta = repo.addItem(input("form:ta:production"));
    const plan = createDailyPlan(repo.listItems(), [], NOW, 2);
    expect(new Set(plan.newItemIds)).toEqual(new Set([te.id, ta.id]));
    const session = repo.getOrCreateInProgressSession("ja", plan.units, NOW, { mode: "today" });
    expect(new Set(session.plannedUnits.map(unit => unit.itemSnapshot!.practice!.activeVariantId!.split(":").at(-1))).size).toBe(2);
  });
  it("requires cross-day due successes AND distinct questions for stability", () => {
    const repo = new MemoryLearningRepository(); const item = repo.addItem(input());
    const schedule: ScheduleState = { learningItemId: item.id, ability: "recall", language: "ja", ruleVersion: 2, evidenceStreak: 5, dueAt: NOW.toISOString(), intervalDays: 30, streak: 5, lapseCount: 0 };
    const attempts: ReviewAttempt[] = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, exerciseId: `e${i}`, sessionId: `s${i}`, learningItemId: item.id, language: "ja", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 1, reviewedAt: new Date(NOW.getTime() + i * 86400000).toISOString(),
      abilityEvidence: { ruleVersion: 2, mode: "today", attemptNumber: 0, wasDue: true, introduced: true, day: `2026-10-${String(7 + i).padStart(2, "0")}`, timeZone: "Asia/Taipei", rawAnswer: "x", normalizedAnswer: "x", originalResult: "correct", question: { ...item, practice: { ...item.practice!, activeVariantId: item.practice!.variants[0].id } }, beforeSchedule: null, corrections: [] } }));
    expect(practiceEvidence(item, [schedule], attempts).status).toBe("learning");
    attempts[1].abilityEvidence!.question.practice!.activeVariantId = item.practice!.variants[1].id;
    attempts[2].abilityEvidence!.question.practice!.activeVariantId = item.practice!.variants[2].id;
    expect(practiceEvidence(item, [schedule], attempts).status).toBe("mastered");
    expect(practiceEvidence({ ...item, contentVersion: 2, practice: { ...item.practice!, enabled: false } }, [schedule], attempts).status).toBe("mastered");
    expect(practiceEvidence(item, [schedule], attempts.map(a => ({ ...a, usedHint: true }))).status).toBe("learning");
    attempts[4].abilityEvidence!.question.practice!.activeVariantId = item.practice!.variants[4].id;
    expect(freezePracticeQuestion(item, [...attempts].reverse()).practice!.activeVariantId).toBe(item.practice!.variants[5].id);
  });
  it("pausing removes future planned questions, preserves quota and an active session, then resumes progress", () => {
    const repo = new MemoryLearningRepository(); const item = repo.addItem(input());
    const plan = createDailyPlan(repo.listItems(), [], NOW, 5);
    const session = repo.getOrCreateInProgressSession("ja", plan.units, NOW, { mode: "today" });
    const paused = repo.editItem(item.id, 1, { promptZh: item.promptZh, answer: item.answer, acceptedAnswers: item.acceptedAnswers, explanation: item.explanation, practice: { ...item.practice!, enabled: false } }, NOW);
    const nextPlan = createDailyPlan(repo.listItems(), [], NOW, 5, false, plan);
    expect(nextPlan.units).toEqual([]); expect(nextPlan.newItemIds).toEqual(plan.newItemIds);
    expect(repo.getInProgressSession("ja")!.plannedUnits).toEqual(session.plannedUnits);
    repo.editItem(item.id, paused.contentVersion!, { promptZh: item.promptZh, answer: item.answer, acceptedAnswers: item.acceptedAnswers, explanation: item.explanation, practice: { ...item.practice!, enabled: true } }, NOW);
    expect(createDailyPlan(repo.listItems(), [], NOW, 5, false, nextPlan).units).toHaveLength(1);
  });
});
