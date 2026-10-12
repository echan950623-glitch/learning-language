import type { AbilityKind, LearningItem, ReviewAttempt, ScheduleState, StudySessionPlannedUnit } from "./types";

import { canonicalJson, hasMixedVocabularyTasks } from "./learningPractice";
import { sameEnglishContent, englishModeVerified } from "./englishPractice";
const DAY = 86_400_000;
/** Product defaults, not a clinical assessment or a universal mastery threshold. */
export const VERIFICATION_LIMIT = 2;
export interface VerificationState {
  stage: "learning" | "pending" | "verified";
  dueAt?: string;
  independentDays: number;
  contextVerified: boolean;
}

/** Only the current content and the same ability can establish retention evidence. */
function relevantAttempts(item: LearningItem, ability: AbilityKind, attempts: ReviewAttempt[]) {
  return attempts.filter(a => {
    const e = a.abilityEvidence;
    const q = e?.question;
    return a.learningItemId === item.id && a.exerciseType === ability && e?.attemptNumber === 0 && q &&
      (item.practice || q.answer === item.answer && q.reading === item.reading) &&
      (item.practice || canonicalJson(q.acceptedAnswers ?? []) === canonicalJson(item.acceptedAnswers ?? []) &&
        (q.answerFormat ?? "vocabulary") === (item.answerFormat ?? "vocabulary")) &&
      (item.practice || (q.verificationQuestion?.basePrompt ?? q.promptZh) === item.promptZh) &&
      (!item.practice || q.practice?.conceptKey === item.practice.conceptKey && q.practice?.capability === item.practice.capability &&
        q.practice.title === item.practice.title &&
        canonicalJson(q.practice.variants) === canonicalJson(item.practice.variants));
  }).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
}

function englishEvidenceHistory(item: LearningItem, attempts: ReviewAttempt[]) {
  // Include failures as well as successes: a failed new context must invalidate stable evidence.
  return attempts.filter(a => a.learningItemId === item.id && a.exerciseType === "meaning" && a.abilityEvidence?.attemptNumber === 0 && sameEnglishContent(item, a.abilityEvidence.question)).sort((a,b) => a.reviewedAt.localeCompare(b.reviewedAt));
}

export function verificationState(item: LearningItem, ability: AbilityKind, schedules: ScheduleState[], attempts: ReviewAttempt[]): VerificationState {
  const schedule = schedules.find(s => s.learningItemId === item.id && s.ability === ability);
  if (item.needsUnderstanding) return { stage: "learning", dueAt: schedule?.dueAt, independentDays: 0, contextVerified: false };
  const history = item.englishPractice ? englishEvidenceHistory(item, attempts) : relevantAttempts(item, ability, attempts);
  let successes: ReviewAttempt[] = [];
  for (const a of history) {
    if (a.result !== "correct" || a.usedHint) { successes = []; continue; }
    if (a.abilityEvidence?.wasDue && !successes.some(s => s.abilityEvidence?.day === a.abilityEvidence?.day)) successes.push(a);
  }
  const last = successes.at(-1);
  const previous = successes.at(-2);
  const gap = last && previous ? Date.parse(last.reviewedAt) - Date.parse(previous.reviewedAt) : 0;
  const tasksVerified = !hasMixedVocabularyTasks(item) || item.practice!.variants.every(v => {
    const task = successes.filter(a => a.abilityEvidence?.question.practice?.activeVariantId === v.id);
    return task.length >= 2 && Date.parse(task.at(-1)!.reviewedAt) - Date.parse(task.at(-2)!.reviewedAt) >= 7 * DAY;
  });
  const verified = item.englishPractice ? englishModeVerified(item, attempts, "direct") && englishModeVerified(item, attempts, "context") : tasksVerified && successes.length >= 2 && gap >= 7 * DAY;
  const request = item.autoVerificationRequestedAt;
  const afterRequest = request && history.some(a => a.reviewedAt >= request && a.abilityEvidence?.question.autoVerificationRequestedAt === request);
  const pending = !!request && !afterRequest && !item.reviewPaused;
  const dueAt = pending
    ? new Date(Date.parse(request!) + DAY).toISOString()
    : verified
      ? new Date(Date.parse(last!.reviewedAt) + (gap >= 30 * DAY ? 60 : 30) * DAY).toISOString()
      : schedule?.dueAt;
  return { stage: pending ? "pending" : verified ? "verified" : "learning", dueAt,
    independentDays: successes.length,
    contextVerified: successes.some(a => a.abilityEvidence?.question.verificationQuestion?.kind === "context" && a.abilityEvidence.question.verificationQuestion.novel) };
}

export function effectiveSchedules(items: LearningItem[], schedules: ScheduleState[], attempts: ReviewAttempt[]): ScheduleState[] {
  const byId = new Map(items.map(i => [i.id, i]));
  return schedules.map(s => {
    const item = byId.get(s.learningItemId);
    const dueAt = item ? verificationState(item, s.ability, schedules, attempts).dueAt : undefined;
    return dueAt ? { ...s, dueAt } : s;
  });
}

/** Reserve due verification before ordinary work so it cannot starve; never fill with non-due stable material. */
export function limitVerificationUnits(units: StudySessionPlannedUnit[], items: LearningItem[], schedules: ScheduleState[], attempts: ReviewAttempt[], cap: number) {
  cap = Math.max(0, Math.floor(cap));
  const byId = new Map(items.map(i => [i.id, i]));
  const verification = (u: StudySessionPlannedUnit) => {
    const item = byId.get(u.learningItemId);
    return !!item && verificationState(item, u.ability, schedules, attempts).stage !== "learning";
  };
  const checks = units.filter(verification).slice(0, Math.min(VERIFICATION_LIMIT, cap));
  const ordinary = units.filter(u => !verification(u));
  return [...checks, ...ordinary].slice(0, cap);
}
