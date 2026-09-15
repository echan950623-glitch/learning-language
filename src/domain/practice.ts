import { requiredAbilities } from "./abilities";
import type { AbilityKind, LearningItem, ReviewAttempt, StudySessionPlannedUnit } from "./types";

interface PracticeCandidate {
  item: LearningItem;
  ability: AbilityKind;
  lastReviewedAt?: string;
}

interface IndexedAttempt {
  attempt: ReviewAttempt;
  index: number;
}

function unitKey(learningItemId: string, ability: AbilityKind): string {
  return `${learningItemId}\u0000${ability}`;
}

function isAbilityKind(exerciseType: ReviewAttempt["exerciseType"]): exerciseType is AbilityKind {
  return exerciseType === "recall" || exerciseType === "reading";
}

function latestAttemptsByUnit(items: LearningItem[], attempts: ReviewAttempt[]): Map<string, ReviewAttempt> {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const latest = new Map<string, IndexedAttempt>();

  attempts.forEach((attempt, index) => {
    const item = itemsById.get(attempt.learningItemId);
    if (!item || item.language !== attempt.language || !isAbilityKind(attempt.exerciseType)) return;
    if (!requiredAbilities(item).includes(attempt.exerciseType)) return;

    const key = unitKey(item.id, attempt.exerciseType);
    const existing = latest.get(key);
    if (
      !existing ||
      attempt.reviewedAt > existing.attempt.reviewedAt ||
      (attempt.reviewedAt === existing.attempt.reviewedAt && index > existing.index)
    ) {
      latest.set(key, { attempt, index });
    }
  });

  return new Map(Array.from(latest, ([key, value]) => [key, value.attempt]));
}

function compareCandidates(a: PracticeCandidate, b: PracticeCandidate): number {
  if (!a.lastReviewedAt && b.lastReviewedAt) return -1;
  if (a.lastReviewedAt && !b.lastReviewedAt) return 1;
  if (a.lastReviewedAt !== b.lastReviewedAt) return (a.lastReviewedAt ?? "").localeCompare(b.lastReviewedAt ?? "");
  if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt.localeCompare(b.item.createdAt);
  if (a.item.id !== b.item.id) return a.item.id.localeCompare(b.item.id);
  return a.ability.localeCompare(b.ability);
}

function toPlannedUnits(candidates: PracticeCandidate[]): StudySessionPlannedUnit[] {
  return candidates.sort(compareCandidates).map(({ item, ability }) => ({
    learningItemId: item.id,
    ability,
    kind: "review",
  }));
}

/** 最新一次仍未答對的 (單字, 能力)；之後答對即不再列入錯題。 */
export function buildWrongAnswerUnits(
  items: LearningItem[],
  attempts: ReviewAttempt[]
): StudySessionPlannedUnit[] {
  const latest = latestAttemptsByUnit(items, attempts);
  const candidates: PracticeCandidate[] = [];

  for (const item of items) {
    for (const ability of requiredAbilities(item)) {
      const latestAttempt = latest.get(unitKey(item.id, ability));
      if (latestAttempt && latestAttempt.result !== "correct") {
        candidates.push({ item, ability, lastReviewedAt: latestAttempt.reviewedAt });
      }
    }
  }

  return toPlannedUnits(candidates);
}

/**
 * 所有曾有作答紀錄的單字都可出題，不看 SRS 到期日。
 * 同一個已出現單字的所有必要能力都可抽；尚未練過的能力優先，再排最久沒練的能力。
 */
export function buildFullReviewUnits(
  items: LearningItem[],
  attempts: ReviewAttempt[]
): StudySessionPlannedUnit[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const encounteredItemIds = new Set(
    attempts
      .filter((attempt) => itemsById.get(attempt.learningItemId)?.language === attempt.language)
      .map((attempt) => attempt.learningItemId)
  );
  const latest = latestAttemptsByUnit(items, attempts);
  const candidates: PracticeCandidate[] = [];

  for (const item of items) {
    if (!encounteredItemIds.has(item.id)) continue;
    for (const ability of requiredAbilities(item)) {
      candidates.push({
        item,
        ability,
        lastReviewedAt: latest.get(unitKey(item.id, ability))?.reviewedAt,
      });
    }
  }

  return toPlannedUnits(candidates);
}
