/**
 * 依「今日佇列裡的一個 (item, ability) 單位」產生練習題。
 *
 * 題型不再依佇列索引奇偶決定（那會讓只有一個單字、或排序固定時永遠只出同一種題型）。
 * 改成佇列建立階段（見 queue.ts）已經依每個項目「持久化的排程歷史」決定好這一題要考
 * recall 還是 reading，這裡單純把決定好的 ability 轉成對應的 Exercise 內容。
 */

import type { AbilityKind, Exercise, LearningItem } from "./types";
import { generateId } from "./id";
import { nowIso } from "./time";

export interface QueueUnitLike {
  item: LearningItem;
  ability: AbilityKind;
}

export function buildExerciseForUnit(item: LearningItem, ability: AbilityKind): Exercise {
  if (ability === "reading") {
    return {
      id: generateId("exercise"),
      exerciseType: "reading",
      learningItemIds: [item.id],
      prompt: item.answer,
      // queue.ts 只有在 hasUsableReading(item) 成立時才會建立 reading 單位，
      // 所以這裡 item.reading 一定存在；仍保留 fallback 避免型別以外的資料異常直接炸掉。
      expectedAnswer: item.reading ?? item.answer,
      createdAt: nowIso(),
    };
  }

  return {
    id: generateId("exercise"),
    exerciseType: "recall",
    learningItemIds: [item.id],
    prompt: item.promptZh,
    expectedAnswer: item.answer,
    createdAt: nowIso(),
  };
}

export function buildExercisesForQueue(units: QueueUnitLike[]): Exercise[] {
  return units.map((unit) => buildExerciseForUnit(unit.item, unit.ability));
}
