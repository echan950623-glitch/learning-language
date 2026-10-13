import { describe, expect, it } from "vitest";
import { scheduleEvidence, evidenceStatus, type EvidenceContext } from "./learningRules";
import { buildTodayQueue } from "./queue";
import { verificationState } from "./automaticVerification";
import { replayLearningEvidence } from "./replayLearningEvidence";
import { getEnglishPracticeCatalog } from "./englishPracticeCatalog";
import { activeEnglishVariant } from "./englishPractice";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore, isScheduleState } from "../repository/schema";
import { rowToScheduleState, scheduleStateToRow } from "../repository/sync/outbox";
import type { AbilityKind, Language, LearningItem, ScheduleState } from "./types";

const start = new Date("2026-10-13T02:00:00Z");
const day = 86_400_000;
const context: EvidenceContext = { reviewPolicy: 1, result: "correct", usedHint: false, attemptNumber: 0, introduced: true, sessionId: "first", timeZone: "Asia/Taipei", now: start };
const japanese: LearningItem = { id: "ja-word", language: "ja", type: "vocabulary", answer: "犬", reading: "いぬ", promptZh: "狗", source: "manual", tags: [], createdAt: start.toISOString(), introducedAt: start.toISOString(), isSeed: false, status: "learning" };

function round(repo: MemoryLearningRepository, item: LearningItem, ability: AbilityKind, now: Date, result: "correct" | "incorrect" = "correct", usedHint = false) {
  const session = repo.getOrCreateInProgressSession(item.language, [{ learningItemId: item.id, ability, kind: "review" }], now, { mode: "today" });
  const snapshot = session.plannedUnits[0].itemSnapshot!;
  const variant = activeEnglishVariant(snapshot);
  const answer = result === "incorrect" ? "不知道" : variant ? variant.choices.find(c => c.id === variant.correctChoiceId)!.text : ability === "reading" ? snapshot.reading! : snapshot.answer;
  return repo.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability, exerciseId: `exercise-${ability}-${now.toISOString()}`, exerciseType: ability, result, usedHint, responseTimeMs: 100, now, rawAnswer: answer, normalizedAnswer: answer });
}

describe("fixed 1/3/5/7/14-day review policy", () => {
  it("advances on days 1, 4, 9, 16, 30 and completes only after passing the final 14-day review", () => {
    let position = scheduleEvidence(undefined, context)!;
    expect(position).toMatchObject({ reviewStage: 0, intervalDays: 1, reviewCompleted: false });
    for (const [index, elapsed] of [1, 4, 9, 16, 30].entries()) {
      expect(position.dueAt).toBe(new Date(start.getTime() + elapsed * day).toISOString());
      position = scheduleEvidence(position, { ...context, sessionId: `review-${index}`, now: new Date(position.dueAt), wasDue: true })!;
      expect(position.reviewStage).toBe(index + 1);
      expect(position.reviewCompleted).toBe(index === 4);
    }
    expect(evidenceStatus(position)).toBe("mastered");
  });
  it("preserves the stage for hints/partial answers, retries tomorrow, and resets wrong answers to next-day recovery", () => {
    let position = scheduleEvidence(undefined, context)!;
    position = scheduleEvidence(position, { ...context, now: new Date(position.dueAt), wasDue: true })!;
    expect(position.reviewStage).toBe(1);
    const hinted = scheduleEvidence(position, { ...context, usedHint: true, sessionId: "hint", now: new Date(position.dueAt), wasDue: true })!;
    expect(hinted).toMatchObject({ reviewStage: 1, intervalDays: 1, reviewCompleted: false });
    const wrong = scheduleEvidence(hinted, { ...context, result: "incorrect", sessionId: "wrong", now: new Date(hinted.dueAt), wasDue: true })!;
    expect(wrong).toMatchObject({ reviewStage: 0, intervalDays: 1, lapseCount: 1, reviewCompleted: false });
    const recovered = scheduleEvidence(wrong, { ...context, sessionId: "recover", now: new Date(wrong.dueAt), wasDue: true })!;
    expect(recovered).toMatchObject({ reviewStage: 1, intervalDays: 3 });
    expect(scheduleEvidence(position, { ...context, result: "partial", now: new Date(position.dueAt), wasDue: true })).toMatchObject({ reviewStage: 1, intervalDays: 1 });
  });
  it("never advances same-day/non-due practice or a bounded retry and does not enroll unintroduced inbox items", () => {
    const initial = scheduleEvidence(undefined, context)!;
    expect(scheduleEvidence(initial, { ...context, now: new Date(start.getTime() + 3600_000), wasDue: false })).toEqual(initial);
    expect(scheduleEvidence(initial, { ...context, attemptNumber: 1, result: "incorrect", now: new Date(initial.dueAt) })).toEqual(initial);
    const advanced = scheduleEvidence(initial, { ...context, now: new Date(initial.dueAt), wasDue: true })!;
    expect(scheduleEvidence(advanced, { ...context, now: new Date(initial.dueAt), wasDue: true })?.reviewStage).toBe(1);
    expect(scheduleEvidence(undefined, { ...context, introduced: false })).toBeUndefined();
  });
  it("preserves a legacy date until due and adopts the new policy without treating old streaks as completed", () => {
    const legacy: ScheduleState = { learningItemId: japanese.id, language: "ja", ability: "recall", dueAt: new Date(start.getTime() + 10 * day).toISOString(), intervalDays: 30, streak: 100, lapseCount: 0, ruleVersion: 2, evidenceStreak: 100 };
    expect(scheduleEvidence(legacy, { ...context, wasDue: false })).toMatchObject(legacy);
    expect(scheduleEvidence(legacy, { ...context, wasDue: false })?.reviewPolicy).toBeUndefined();
    const adopted = scheduleEvidence(legacy, { ...context, now: new Date(legacy.dueAt), wasDue: true })!;
    expect(adopted).toMatchObject({ reviewPolicy: 1, reviewStage: 1, intervalDays: 3, reviewCompleted: false });
    expect(evidenceStatus(adopted)).toBe("learning");
  });
  it("retires each Japanese ability independently, persists all progress metadata, and reactivates on an actual failure", () => {
    const repo = new MemoryLearningRepository({ ...createEmptyStore(), items: [japanese] });
    let position: ScheduleState | undefined;
    for (const elapsed of [0, 1, 4, 9, 16, 30]) position = round(repo, japanese, "recall", new Date(start.getTime() + elapsed * day)).schedule;
    expect(position?.reviewCompleted).toBe(true);
    const future = new Date(start.getTime() + 300 * day);
    const queue = buildTodayQueue([japanese], repo.listScheduleStates(), future, 50, repo.listReviewAttempts());
    expect(queue.units.some(u => u.ability === "recall")).toBe(false);
    expect(queue.units.some(u => u.ability === "reading")).toBe(true);
    expect(repo.getItem(japanese.id)?.status).toBe("learning");
    expect(rowToScheduleState(scheduleStateToRow(position!, "test-owner"))).toEqual(position);
    expect(isScheduleState(position)).toBe(true);
    expect(replayLearningEvidence(japanese, repo.listReviewAttempts(), position)).toEqual(position);
    const failed = round(repo, japanese, "recall", future, "incorrect");
    expect(failed.schedule).toMatchObject({ reviewStage: 0, reviewCompleted: false, intervalDays: 1 });
    expect(buildTodayQueue([japanese], repo.listScheduleStates(), new Date(failed.schedule.dueAt), 50, repo.listReviewAttempts()).reviewUnits.some(u => u.ability === "recall")).toBe(true);
  });
  it("requires both Japanese abilities and both English modes; final English review uses held-out context", () => {
    const en: LearningItem = { ...getEnglishPracticeCatalog()[0], id: "en-word", createdAt: start.toISOString(), introducedAt: start.toISOString(), isSeed: false, status: "learning" };
    const repo = new MemoryLearningRepository({ ...createEmptyStore(), items: [japanese, en] });
    for (const ability of ["recall", "reading", "meaning"] as const) {
      const item = ability === "meaning" ? en : japanese;
      let outcome;
      // Separate reading from exposure to the just-shown word; assisted work must not count as evidence.
      for (const elapsed of [0, 1, 4, 9, 16, 30]) outcome = round(repo, item, ability, new Date(start.getTime() + elapsed * day + (ability === "reading" ? 300_000 : 0)));
      expect(outcome!.schedule.reviewCompleted, ability).toBe(true);
      if (ability === "meaning") expect(activeEnglishVariant(outcome!.attempt.abilityEvidence!.question)?.role).toBe("verification");
    }
    expect(repo.getItem(japanese.id)?.status).toBe("mastered");
    expect(repo.getItem(en.id)?.status).toBe("mastered");
    for (const language of ["ja", "en"] as Language[]) {
      const items = repo.listItems({ language });
      expect(buildTodayQueue(items, repo.listScheduleStates({ language }), new Date(start.getTime() + 300 * day), 50, repo.listReviewAttempts({ language })).units).toEqual([]);
    }
    const englishHistory = repo.listReviewAttempts({ language: "en" });
    const englishPosition = repo.listScheduleStates({ language: "en" })[0];
    expect(replayLearningEvidence(en, englishHistory, englishPosition)).toEqual(englishPosition);
    expect(verificationState(en, "meaning", [{ ...englishPosition, reviewCompleted: false }], englishHistory).stage).toBe("learning");
  });
});
