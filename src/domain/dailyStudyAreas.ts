import { createDailyPlan } from "./learningRules";
import type { DailyPlan, Language, LearningItem, ReviewAttempt, ScheduleState } from "./types";

export type DailyStudyArea = "new" | "review";
export const DAILY_AREA_NEW_WORD_CAP = 50;

export function createDailyAreaPlan(items: LearningItem[], schedules: ScheduleState[], now: Date, existing?: DailyPlan, attempts: ReviewAttempt[] = [], language: Language = "ja") {
  return createDailyPlan(items, schedules, now, DAILY_AREA_NEW_WORD_CAP, false, existing, undefined, attempts, language, true);
}

export function dailyAreaUnits(plan: DailyPlan, area: DailyStudyArea) {
  const fresh = new Set(plan.newItemIds);
  const completed = new Set(plan.completedUnitKeys);
  return plan.units.filter(unit => !completed.has(`${unit.learningItemId}:${unit.ability}`) &&
    (area === "new" ? fresh.has(unit.learningItemId) : !fresh.has(unit.learningItemId)));
}
