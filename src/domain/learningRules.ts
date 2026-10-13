import type { ReviewAttempt, AttemptResult, DailyPlan, LearningItem, ScheduleState, StudySessionPlannedUnit, Language } from "./types";
import { computeNextSchedule } from "./srs";
import { buildTodayQueue } from "./queue";
import { isPracticeEligible } from "./learningPractice";
import { FIXED_REVIEW_POLICY, FINAL_REVIEW_STAGE, fixedReviewInterval } from "./fixedReview";

export const LEARNING_RULE_VERSION = 2 as const;
export const STABLE_EVIDENCE_COUNT = 5;
export const RETRY_GAP = 3;
export const MAX_RETRIES = 2;
export const DEFAULT_LEARNING_TIME_ZONE = "Asia/Taipei";
export const NORMAL_DAILY_UNIT_BUDGET = 20;
export const BUSY_DAILY_UNIT_BUDGET = 5;
export const MIN_FRESH_RECALL_DELAY_MS = 3 * 60_000;
export function learningDay(now: Date, timeZone = DEFAULT_LEARNING_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function evidenceStatus(schedule: ScheduleState | undefined) {
  if (!schedule) return "new" as const;
  if (schedule.ruleVersion !== 2) return "learning" as const; // Legacy evidence cannot establish unhinted cross-day stability.
  if (schedule.reviewPolicy === FIXED_REVIEW_POLICY) {
    if (schedule.reviewCompleted) return "mastered" as const;
    return (schedule.recentFailures ?? 0) >= 3 ? "struggling" as const : "learning" as const;
  }
  if ((schedule.evidenceStreak ?? 0) >= STABLE_EVIDENCE_COUNT) return "mastered" as const;
  return (schedule.recentFailures ?? 0) >= 3 ? "struggling" as const : "learning" as const;
}
export interface EvidenceContext { reviewPolicy?: 1; result: AttemptResult; usedHint: boolean; attemptNumber: number; introduced: boolean; sessionId: string; timeZone: string; now: Date; wasDue?: boolean }
/** New scheduling decisions only; legacy history and pre-existing due dates stay intact. */
export function scheduleEvidence(previous: ScheduleState | undefined, context: EvidenceContext): ScheduleState | undefined {
  const { result, usedHint, attemptNumber, introduced, now, timeZone, sessionId } = context;
  if (!previous && !introduced) return undefined; // A quiz of inbox content does not enroll it.
  const base = previous ?? { learningItemId: "", language: "ja", ability: "recall", dueAt: now.toISOString(), intervalDays: 1, streak: 0, lapseCount: 0 } as ScheduleState;
  if (attemptNumber > 0) return { ...base };
  const due = context.wasDue !== false && !!previous && Date.parse(previous.dueAt) <= now.getTime();
  const sameEvidenceDay = previous?.lastEvidenceAt && learningDay(new Date(previous.lastEvidenceAt), timeZone) === learningDay(now, timeZone);
  if (result === "correct" && previous && (!due || sameEvidenceDay)) {
    return usedHint ? { ...base } : { ...base, recentFailures: 0 }; // Record practice, without extending the interval.
  }
  if (result === "incorrect" && previous?.lastPenaltySessionId === sessionId) return { ...base };
  if (context.reviewPolicy === FIXED_REVIEW_POLICY) {
    const eligibleSuccess = result === "correct" && !usedHint && due && !sameEvidenceDay;
    const previousStage = previous?.reviewPolicy === FIXED_REVIEW_POLICY ? previous.reviewStage ?? 0 : 0;
    const reviewStage = result === "incorrect" ? 0 : result !== "correct" || usedHint
      ? Math.min(previousStage, FINAL_REVIEW_STAGE - 1)
      : Math.min(FINAL_REVIEW_STAGE, previousStage + (eligibleSuccess ? 1 : 0));
    const intervalDays = result !== "correct" || usedHint ? 1 : fixedReviewInterval(reviewStage);
    return {
      ...base, ruleVersion: LEARNING_RULE_VERSION, reviewPolicy: FIXED_REVIEW_POLICY, reviewStage, reviewCompleted: reviewStage >= FINAL_REVIEW_STAGE,
      dueAt: new Date(now.getTime() + intervalDays * 86_400_000).toISOString(), intervalDays,
      streak: result === "incorrect" ? 0 : result === "correct" && !usedHint ? (previous?.streak ?? 0) + 1 : previous?.streak ?? 0,
      lapseCount: (previous?.lapseCount ?? 0) + (result === "incorrect" ? 1 : 0),
      lastReviewedAt: now.toISOString(),
      evidenceStreak: eligibleSuccess ? (previous?.reviewPolicy === FIXED_REVIEW_POLICY ? previous.evidenceStreak ?? 0 : 0) + 1 : result === "incorrect" ? 0 : previous?.evidenceStreak ?? 0,
      lastEvidenceAt: eligibleSuccess ? now.toISOString() : previous?.lastEvidenceAt,
      recentFailures: result === "incorrect" ? (previous?.recentFailures ?? 0) + 1 : result === "correct" && !usedHint ? 0 : previous?.recentFailures ?? 0,
      lastPenaltySessionId: result === "incorrect" ? sessionId : previous?.lastPenaltySessionId,
    };
  }
  const computed = computeNextSchedule(previous ? { streak: previous.streak, lapseCount: previous.lapseCount } : null, usedHint && result === "correct" ? "partial" : result, now);
  const eligibleSuccess = result === "correct" && !usedHint && due && !sameEvidenceDay;
  return {
    ...base, dueAt: computed.dueAt, intervalDays: computed.intervalDays, streak: computed.streak, lapseCount: computed.lapseCount,
    lastReviewedAt: now.toISOString(), ruleVersion: LEARNING_RULE_VERSION,
    evidenceStreak: eligibleSuccess ? (previous?.evidenceStreak ?? 0) + 1 : result === "incorrect" ? 0 : previous?.evidenceStreak ?? 0,
    lastEvidenceAt: eligibleSuccess ? now.toISOString() : previous?.lastEvidenceAt,
    recentFailures: result === "incorrect" ? (previous?.recentFailures ?? 0) + 1 : result === "correct" && !usedHint ? 0 : previous?.recentFailures ?? 0,
    lastPenaltySessionId: result === "incorrect" ? sessionId : previous?.lastPenaltySessionId,
  };
}
/** The plan reserves distinct words; supplementing reading never consumes a new word. */
export function createDailyPlan(items: LearningItem[], schedules: ScheduleState[], now: Date, cap: number, busy = false, existing?: DailyPlan, timeZone = DEFAULT_LEARNING_TIME_ZONE, attempts: ReviewAttempt[] = [], language: Language = "ja", split = false): DailyPlan {
  if (!Number.isSafeInteger(cap) || cap < 0 || cap > 50) throw new Error("每日新字上限不合法。");
  items = items.filter(i => i.language === language);
  schedules = schedules.filter(s => s.language === language);
  attempts = attempts.filter(a => a.language === language);
  const date = learningDay(now, timeZone);
  if (existing && (existing.date !== date || existing.timeZone !== timeZone || existing.language !== language)) throw new Error("不能把其他學習日的額度沿用到今天。");
  const queue = buildTodayQueue(items, schedules, now, items.length * 2, attempts, split);
  const reserved = new Set(existing?.newItemIds ?? []);
  const completed = new Set(existing?.completedUnitKeys ?? []);
  const eligibleIds = new Set(items.filter(isPracticeEligible).map(item => item.id));
  const available = new Set(queue.units.map(u => `${u.item.id}:${u.ability}`));
  const units = new Map((existing?.units ?? []).filter(unit => eligibleIds.has(unit.learningItemId) && (completed.has(`${unit.learningItemId}:${unit.ability}`) || available.has(`${unit.learningItemId}:${unit.ability}`))).map(unit => [`${unit.learningItemId}:${unit.ability}`, structuredClone(unit)]));
  for (const item of items.filter(item => item.needsUnderstanding)) {
    for (const unit of units.values()) {
      if (unit.learningItemId !== item.id) continue;
      completed.delete(`${item.id}:${unit.ability}`);
      unit.itemSnapshot = structuredClone(item);
      unit.itemVersion = item.contentVersion ?? 1;
      unit.requiresIntroduction = (unit.ability === "recall" || unit.ability === "meaning");
    }
  }
  const overdue = queue.reviewUnits.length >= 20;
  for (const unit of queue.units) {
    const key = `${unit.item.id}:${unit.ability}`;
    if (units.has(key) || completed.has(key)) continue;
    if (!split && units.size >= (busy ? BUSY_DAILY_UNIT_BUDGET : NORMAL_DAILY_UNIT_BUDGET)) break;
    const fresh = !unit.item.introducedAt && !schedules.some(s => s.learningItemId === unit.item.id) && (!split || !unit.item.practice);
    if (fresh && !reserved.has(unit.item.id)) {
      if (busy || (!split && overdue) || reserved.size >= cap || (!split && language === "en" && existing)) continue;
      reserved.add(unit.item.id);
    }
    if (busy && unit.kind !== "review") continue;
    units.set(key, { learningItemId: unit.item.id, ability: unit.ability, kind: unit.kind, attemptNumber: 0,
      requiresIntroduction: (fresh || !!unit.item.needsUnderstanding) && (unit.ability === "recall" || unit.ability === "meaning"), itemVersion: unit.item.contentVersion ?? 1, itemSnapshot: structuredClone(unit.item) });
  }
  return { id: `${language}:${date}`, date, language, timeZone, ruleVersion: LEARNING_RULE_VERSION, newItemCap: cap,
    newItemIds: [...reserved], units: [...units.values()].sort((a, b) => {
      const priority = (unit: StudySessionPlannedUnit) => unit.kind === "review" ? 0 : !reserved.has(unit.learningItemId) ? 1 : (unit.ability === "recall" || unit.ability === "meaning") ? 2 : 3;
      return priority(a) - priority(b);
    }), completedUnitKeys: [...completed],
    reason: split ? `新字每日最多 ${cap} 個；到期複習全部列入，不限題數。` : busy ? "忙碌模式：只做必要複習。" : overdue ? "積欠較多，先消化到期複習，暫停新增。" : `到期複習優先，每日最多 ${cap} 個不同新字。`, busy, updatedAt: now.toISOString() };
}
export function enqueueRetry(units: StudySessionPlannedUnit[], index: number, result: AttemptResult, usedHint: boolean): StudySessionPlannedUnit[] {
  const unit = units[index];
  if ((result === "correct" && !usedHint) || (unit.attemptNumber ?? 0) >= MAX_RETRIES) return units;
  const position = index + RETRY_GAP + 1;
  if (position > units.length) return units; // No immediate answer-copying at the tail.
  const next = structuredClone(units);
  next.splice(position, 0, { ...structuredClone(unit), attemptNumber: (unit.attemptNumber ?? 0) + 1, requiresIntroduction: false });
  return next;
}
