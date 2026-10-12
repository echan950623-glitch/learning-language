import { effectiveSchedules, limitVerificationUnits, verificationState } from "./automaticVerification";
import { isPracticeEligible } from "./learningPractice";
import { buildQuickQuizUnits, buildWrongAnswerUnits } from "./practice";
import type { PracticeSource } from "./practiceSelection";
import type { LearningItem, ReviewAttempt, ScheduleState, StudyMode, StudySessionPlannedUnit } from "./types";

export const ENGLISH_PRACTICE_CATEGORIES = [
  { id: "vocabulary", label: "單字", description: "單字詞義・句中辨義" },
  { id: "phrase", label: "片語", description: "片語・固定搭配的用法" },
  { id: "toeic", label: "多益專區", description: "多益主題練習・內容準備中" },
] as const;
export type EnglishPracticeCategory = (typeof ENGLISH_PRACTICE_CATEGORIES)[number]["id"];
export interface EnglishPracticeSelection {
  category: EnglishPracticeCategory;
  source: PracticeSource;
  questionCount: number;
}

export function learnedEnglishPracticeItems(items: LearningItem[], attempts: ReviewAttempt[], schedules: ScheduleState[], category: EnglishPracticeCategory) {
  // TOEIC is a reserved, empty area; workplace tags alone do not make a TOEIC course.
  if (category === "toeic") return [];
  const seen = new Set([
    ...attempts.filter(a => a.language === "en").map(a => a.learningItemId),
    ...schedules.filter(s => s.language === "en").map(s => s.learningItemId),
  ]);
  return items.filter(item => item.language === "en" && isPracticeEligible(item) &&
    (category === "vocabulary" ? item.type === "vocabulary" : item.type === "phrase" || item.type === "collocation") &&
    (!!item.introducedAt || seen.has(item.id)));
}

export function selectEnglishPracticeUnits(items: LearningItem[], attempts: ReviewAttempt[], schedules: ScheduleState[], selection: EnglishPracticeSelection, now: Date, random: () => number = Math.random): { units: StudySessionPlannedUnit[]; total: number; mode: StudyMode } {
  const candidates = learnedEnglishPracticeItems(items, attempts, schedules, selection.category);
  let units = buildQuickQuizUnits(candidates, Number.MAX_SAFE_INTEGER, random);
  const key = (unit: StudySessionPlannedUnit) => `${unit.learningItemId}:${unit.ability}`;
  const due = new Map(effectiveSchedules(candidates, schedules, attempts)
    .filter(s => s.language === "en" && s.ability === "meaning" && Date.parse(s.dueAt) <= now.getTime())
    .map(s => [`${s.learningItemId}:${s.ability}`, s.dueAt]));
  const wrong = new Set(buildWrongAnswerUnits(candidates, attempts).map(key));
  if (selection.source === "due") {
    units = units.filter(u => due.has(key(u))).sort((a, b) => due.get(key(a))!.localeCompare(due.get(key(b))!));
  } else if (selection.source === "wrong") {
    units = units.filter(u => wrong.has(key(u)));
  } else if (selection.source === "recommended") {
    const byId = new Map(candidates.map(item => [item.id, item]));
    units = units.filter(u => due.has(key(u)) ||
      (verificationState(byId.get(u.learningItemId)!, u.ability, schedules, attempts).stage === "learning" &&
        (wrong.has(key(u)) || !schedules.some(s => s.learningItemId === u.learningItemId && s.ability === u.ability))));
    const priority = (u: StudySessionPlannedUnit) => due.has(key(u)) ? 0 : wrong.has(key(u)) ? 1 : 2;
    units.sort((a, b) => priority(a) - priority(b));
  }
  const total = units.length;
  if (selection.source === "recommended" || selection.source === "due") {
    units = limitVerificationUnits(units, candidates, schedules, attempts, selection.questionCount);
  }
  return {
    total,
    units: units.slice(0, Math.max(0, Math.floor(selection.questionCount))),
    mode: selection.source === "wrong" ? "wrong" : selection.source === "all" ? "full" : "random",
  };
}
