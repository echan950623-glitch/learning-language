/**
 * 建立「今日學習」佇列：到期複習優先，再排新內容。
 * 純函式，輸入 items／scheduleStates／now，輸出固定，方便測試。
 *
 * 2026-09-14 repair batch（R1）：佇列的最小單位從「一個 LearningItem」改成
 * 「一個 (LearningItem, ability) 組合」。理由：含漢字讀音的單字需要 recall（中文→日文）
 * 與 reading（漢字→假名）各自獨立的到期排程，不然只出現在佇列一次就只能練到其中一種
 * 題型，另一種永遠不會被排到，卻仍然因為 item-level 的單一 streak 被判定 mastered。
 * 詳細規則見 domain/abilities.ts（一個項目需要哪些能力）與 domain/srs.ts
 * （combineAbilityStatuses 如何合併多能力狀態）。
 */

import type { AbilityKind, LearningItem, ScheduleState } from "./types";
import { requiredAbilities } from "./abilities";
import { isDueBy } from "./time";

/** 系統建議的每日新內容數（非 KPI，只是第一版預設值） */
export const DEFAULT_NEW_ITEM_SUGGESTION = 5;

/** 單一語言每日新項目技術防呆上限（PRODUCT_SPEC 第 3 節），避免不小心無限塞新內容 */
export const DAILY_NEW_ITEM_SAFETY_CAP = 50;

/** 粗估每題平均花費秒數，用於首頁「預估完成時間」 */
export const DEFAULT_SECONDS_PER_EXERCISE = 40;

export type QueueEntryKind = "review" | "new";

export interface TodayQueueUnit {
  item: LearningItem;
  ability: AbilityKind;
  kind: QueueEntryKind;
  /** kind === "review" 時，這個能力目前的排程狀態；kind === "new" 時不存在 */
  schedule?: ScheduleState;
}

export interface TodayQueueResult {
  reviewUnits: TodayQueueUnit[];
  newUnits: TodayQueueUnit[];
  /** reviewUnits 接 newUnits，就是今天實際要問的題目順序 */
  units: TodayQueueUnit[];
}

function scheduleKey(learningItemId: string, ability: AbilityKind): string {
  return `${learningItemId}:${ability}`;
}

export function buildTodayQueue(
  items: LearningItem[],
  scheduleStates: ScheduleState[],
  now: Date,
  newItemLimit: number = DEFAULT_NEW_ITEM_SUGGESTION
): TodayQueueResult {
  const scheduleByKey = new Map(scheduleStates.map((s) => [scheduleKey(s.learningItemId, s.ability), s]));
  const nowIsoValue = now.toISOString();

  const reviewUnits: TodayQueueUnit[] = [];
  /** 完全沒碰過的項目：只把 recall 當新內容引入，reading 留到 recall 有紀錄後才出現。 */
  const freshItemUnits: TodayQueueUnit[] = [];
  /** recall 已經有排程紀錄、但 reading（必要能力）還沒被引入過的項目：補齊第二種能力。 */
  const pendingAbilityUnits: TodayQueueUnit[] = [];

  for (const item of items) {
    const abilities = requiredAbilities(item);
    const recallSchedule = scheduleByKey.get(scheduleKey(item.id, "recall"));

    for (const ability of abilities) {
      const schedule = scheduleByKey.get(scheduleKey(item.id, ability));

      if (schedule) {
        if (isDueBy(schedule.dueAt, nowIsoValue)) {
          reviewUnits.push({ item, ability, kind: "review", schedule });
        }
        continue;
      }

      // 這個能力還沒有任何排程紀錄。
      if (ability === "recall") {
        if (!recallSchedule) {
          freshItemUnits.push({ item, ability: "recall", kind: "new" });
        }
        // recallSchedule 存在但這裡 schedule 卻是 undefined 不會發生（ability==="recall" 時
        // schedule 就是 recallSchedule），保留分支只是讓邏輯讀起來完整。
      } else if (recallSchedule) {
        // recall 已經開始學了，reading 才有資格被當成「補齊能力」的新內容引入；
        // 完全沒碰過的項目不會同時把 recall 跟 reading 一次塞進今天的新內容。
        pendingAbilityUnits.push({ item, ability, kind: "new" });
      }
    }
  }

  reviewUnits.sort((a, b) => {
    const dueA = a.schedule?.dueAt ?? "";
    const dueB = b.schedule?.dueAt ?? "";
    if (dueA !== dueB) return dueA.localeCompare(dueB);
    return a.item.createdAt.localeCompare(b.item.createdAt);
  });

  // 新內容優先順序：先補齊「已經開始學、還缺一種能力」的項目，再引入全新項目，
  // 避免已經投入的項目長期卡在只學一半，同時每個「全新項目」在單一天內仍只算一次新增。
  pendingAbilityUnits.sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));
  freshItemUnits.sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));

  const cap = Math.max(0, Math.min(newItemLimit, DAILY_NEW_ITEM_SAFETY_CAP));
  const newUnits = [...pendingAbilityUnits, ...freshItemUnits].slice(0, cap);

  return {
    reviewUnits,
    newUnits,
    units: [...reviewUnits, ...newUnits],
  };
}

/**
 * 把完整佇列裁成一次學習的總題數。buildTodayQueue 已把到期複習排在新內容前面，
 * 因此直接取前 N 題就能維持「複習優先，剩餘名額才補新內容」。
 */
export function limitTodayQueue(queue: TodayQueueResult, questionCount: number): TodayQueueResult {
  const cap = Math.max(0, Math.floor(questionCount));
  const units = queue.units.slice(0, cap);
  const reviewUnits = units.filter((unit) => unit.kind === "review");
  const newUnits = units.filter((unit) => unit.kind === "new");
  return { reviewUnits, newUnits, units };
}

/** 依題數粗估完成分鐘數，至少 0 分鐘；有題目時至少顯示 1 分鐘，避免顯示「0 分鐘」誤導使用者。 */
export function estimateMinutes(
  entryCount: number,
  secondsPerItem: number = DEFAULT_SECONDS_PER_EXERCISE
): number {
  if (entryCount <= 0) return 0;
  return Math.max(1, Math.round((entryCount * secondsPerItem) / 60));
}
