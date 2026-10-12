import { buildQuickQuizUnits, buildWrongAnswerUnits } from "./practice";
import { effectiveSchedules, verificationState, limitVerificationUnits } from "./automaticVerification";
import { isPracticeEligible } from "./learningPractice";
import type {
  LearningItem,
  ReviewAttempt,
  ScheduleState,
  StudyMode,
  StudySessionPlannedUnit,
} from "./types";
export const PRACTICE_CATEGORIES = [
  { id: "vocabulary", label: "單字與漢字", description: "意思・讀音" },
  {
    id: "conjugation",
    label: "形態變化",
    description: "各種形式・普通體與禮貌體",
  },
  { id: "grammar", label: "文法", description: "接續・使用情境" },
  { id: "sentence", label: "助詞與句構", description: "助詞・句子結構" },
  { id: "collocation", label: "常見搭配", description: "單字放在一起怎麼用" },
  { id: "reading", label: "閱讀", description: "短句・短文理解" },
] as const;
export type PracticeCategory = (typeof PRACTICE_CATEGORIES)[number]["id"];
export type PracticeSource = "recommended" | "due" | "wrong" | "all";
export type PracticeSkill =
  | "mixed"
  | "recall"
  | "reading"
  | "recognition"
  | "production"
  | "usage";
export interface PracticeSelection {
  category: PracticeCategory;
  source: PracticeSource;
  skill: PracticeSkill;
  concepts: string[];
  questionCount: number;
}
export function practiceCategory(
  item: LearningItem,
): PracticeCategory | undefined {
  if (item.practice)
    return item.practice.kind === "particle" ||
      item.practice.kind === "structure"
      ? "sentence"
      : item.practice.kind;
  return item.type === "vocabulary" && !item.coachReport
    ? "vocabulary"
    : undefined;
}
export function learnedPracticeItems(
  items: LearningItem[],
  attempts: ReviewAttempt[],
  schedules: ScheduleState[],
  category: PracticeCategory,
) {
  const seen = new Set([
    ...attempts.map((a) => a.learningItemId),
    ...schedules.map((s) => s.learningItemId),
  ]);
  return items.filter(
    (i) =>
      i.language === "ja" &&
      isPracticeEligible(i) &&
      practiceCategory(i) === category &&
      (i.practice ? i.practice.learned : !!i.introducedAt || seen.has(i.id)),
  );
}
export function selectPracticeUnits(
  items: LearningItem[],
  attempts: ReviewAttempt[],
  schedules: ScheduleState[],
  selection: PracticeSelection,
  now: Date,
  random: () => number = Math.random,
): { units: StudySessionPlannedUnit[]; mode: StudyMode; total: number } {
  const candidates = learnedPracticeItems(
    items,
    attempts,
    schedules,
    selection.category,
  ).filter(
    (i) =>
      (!selection.concepts.length ||
        (!!i.practice && selection.concepts.includes(i.practice.conceptKey))) &&
      (selection.skill === "mixed" ||
        !i.practice ||
        i.practice.capability === selection.skill),
  );
  let units = buildQuickQuizUnits(
    candidates,
    Number.MAX_SAFE_INTEGER,
    random,
  ).filter(
    (u) =>
      (selection.skill !== "recall" && selection.skill !== "reading") ||
      u.ability === selection.skill,
  );
  const key = (u: StudySessionPlannedUnit) =>
    `${u.learningItemId}:${u.ability}`;
  const due = new Map(
    effectiveSchedules(items, schedules, attempts)
      .filter((s) => new Date(s.dueAt).getTime() <= now.getTime())
      .map((s) => [`${s.learningItemId}:${s.ability}`, s.dueAt]),
  );
  const wrong = new Set(buildWrongAnswerUnits(candidates, attempts).map(key));
  if (selection.source === "due")
    units = units
      .filter((u) => due.has(key(u)))
      .sort((a, b) => due.get(key(a))!.localeCompare(due.get(key(b))!));
  else if (selection.source === "wrong")
    units = units.filter((u) => wrong.has(key(u)));
  else if (selection.source === "recommended") {
    units = units.filter(u => {
      const item = candidates.find(i => i.id === u.learningItemId)!;
      const state = verificationState(item, u.ability, schedules, attempts);
      return due.has(key(u)) || (state.stage === "learning" && (wrong.has(key(u)) || !schedules.some(s => s.learningItemId === u.learningItemId && s.ability === u.ability)));
    });
    units.sort(
      (a, b) =>
        (due.has(key(a)) ? 0 : wrong.has(key(a)) ? 1 : 2) -
        (due.has(key(b)) ? 0 : wrong.has(key(b)) ? 1 : 2),
    );
  }
  const total = units.length;
  if (selection.source === "recommended" || selection.source === "due") {
    units = limitVerificationUnits(units, candidates, schedules, attempts, selection.questionCount);
  }
  return {
    total,
    units: units.slice(0, Math.max(0, Math.floor(selection.questionCount))),
    mode:
      selection.source === "wrong"
        ? "wrong"
        : selection.source === "all"
          ? "full"
          : "random",
  };
}
