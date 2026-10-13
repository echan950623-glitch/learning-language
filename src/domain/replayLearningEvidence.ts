import type { LearningItem, ReviewAttempt, ScheduleState } from "./types";
import { scheduleEvidence } from "./learningRules";
import { englishModeVerified } from "./englishPractice";

/** Replay only classified events for this content version. Legacy history is a frozen baseline. */
export function replayLearningEvidence(item: LearningItem, attempts: ReviewAttempt[], fallback: ScheduleState | undefined): ScheduleState | undefined {
  const classified = attempts.filter(attempt => attempt.learningItemId === item.id && attempt.abilityEvidence &&
    (attempt.abilityEvidence.question.contentVersion ?? 1) === (item.contentVersion ?? 1))
    .sort((a,b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
  if (!classified.length) return fallback ? structuredClone(fallback) : undefined;
  const first = classified[0];
  let schedule = first.abilityEvidence!.beforeSchedule ?? undefined;
  if (schedule?.lastReviewedAt && Date.parse(schedule.lastReviewedAt) > Date.parse(first.reviewedAt))
    throw new Error("作答早於可確認的排程基準；原事件已保留，需要人工核對。");
  for (const [index, attempt] of classified.entries()) {
    const evidence = attempt.abilityEvidence!;
    schedule = scheduleEvidence(schedule, { reviewPolicy: evidence.reviewPolicy, result: attempt.result, usedHint: attempt.usedHint, attemptNumber: evidence.attemptNumber,
      introduced: evidence.introduced, sessionId: attempt.sessionId, timeZone: evidence.timeZone, now: new Date(attempt.reviewedAt), wasDue: evidence.wasDue });
    if (schedule) schedule = { ...schedule, learningItemId: item.id, language: item.language, ability: attempt.exerciseType === "meaning" ? "meaning" : attempt.exerciseType === "reading" ? "reading" : "recall" };
    if (schedule?.reviewPolicy === 1 && schedule.reviewStage === 5 && item.englishPractice) {
      const history = classified.slice(0, index + 1);
      schedule.reviewCompleted = englishModeVerified(item, history, "direct") && englishModeVerified(item, history, "context");
    }
  }
  return schedule;
}
