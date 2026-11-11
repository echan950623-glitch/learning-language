import { createDailyPlan } from "./learningRules";
import type { DailyPlan, Language, LearningItem, ReviewAttempt, ScheduleState, StudySessionPlannedUnit } from "./types";

export type DailyStudyArea = "new" | "review";
/** Technical ceiling shared with the database check; the learner's own preference decides the actual daily quota. */
export const DAILY_AREA_NEW_WORD_CAP = 50;
/** Words introduced per new-word round, so understanding cards are recalled while still fresh. */
export const NEW_WORD_BATCH_SIZE = 5;
/** A round with fewer than four introductions triggers the fresh-recall wait, so a short tail joins the previous round. */
const NEW_WORD_BATCH_TAIL = 3;

export function createDailyAreaPlan(items: LearningItem[], schedules: ScheduleState[], now: Date, existing?: DailyPlan, attempts: ReviewAttempt[] = [], language: Language = "ja", cap: number = DAILY_AREA_NEW_WORD_CAP) {
  return createDailyPlan(items, schedules, now, cap, false, existing, undefined, attempts, language, true);
}

export function dailyAreaUnits(plan: DailyPlan, area: DailyStudyArea) {
  const fresh = new Set(plan.newItemIds);
  const completed = new Set(plan.completedUnitKeys);
  return plan.units.filter(unit => !completed.has(`${unit.learningItemId}:${unit.ability}`) &&
    (area === "new" ? fresh.has(unit.learningItemId) : !fresh.has(unit.learningItemId)));
}

/**
 * One round of the new-word area. Words already introduced today (their remaining abilities) come first,
 * followed by the next few unseen words; the rest of today's quota waits for a later round.
 */
export function newWordBatchUnits(units: StudySessionPlannedUnit[], size: number = NEW_WORD_BATCH_SIZE): StudySessionPlannedUnit[] {
  const unseen: string[] = [], started: string[] = [];
  for (const unit of units) {
    const group = units.some(other => other.learningItemId === unit.learningItemId && other.requiresIntroduction) ? unseen : started;
    if (!unseen.includes(unit.learningItemId) && !started.includes(unit.learningItemId)) group.push(unit.learningItemId);
  }
  const chosen = new Set([...started.slice(0, size), ...(unseen.length <= size + NEW_WORD_BATCH_TAIL ? unseen : unseen.slice(0, size))]);
  return units.filter(unit => chosen.has(unit.learningItemId));
}
