/**
 * MCP 工具：`get_learning_context`。只讀，重用 `src/domain/stats.ts`／`src/domain/practice.ts`
 * 既有且已測試的純函式做統計，這裡只負責「查 RLS-scoped 的 rows → 轉成 domain 型別 →
 * 呼叫 domain 函式 → 整形成輸出 schema」，不重新實作任何 SRS／統計數學。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { buildWrongAnswerUnits } from "@/domain/practice";
import {
  computeAbilityStatusCounts,
  computeAccuracyOverWindow,
  computeHintRateOverWindow,
  computeStatusCounts,
  computeUpcomingReviewOverview,
} from "@/domain/stats";
import type { Language } from "@/domain/types";
import {
  mapLearningItemRow,
  mapReviewAttemptRow,
  mapScheduleStateRow,
  type LearningItemRow,
  type ReviewAttemptRow,
  type ScheduleStateRow,
} from "@/lib/mcp/supabaseRows";

export const name = "get_learning_context";

export const title = "取得學習狀態總覽";

export const description =
  "取得使用者目前的學習狀態總覽（只讀，不會修改任何資料）：依語言（日文／英文）分別回報" +
  "熟練度分布、到期複習數、近 N 天正確率與提示使用率、依能力（漢字／單字練習 recall、" +
  "平假名練習 reading）拆分的狀態、錯題數與作答量。用來讓 AI 助理了解使用者目前的學習" +
  "狀況，才能給出有根據的複習建議，不是用來修改任何資料。";

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

export const inputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]).default(7).describe("回顧的天數視窗，只能是 7 或 30，預設 7"),
});

const statusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  new: z.number().int().nonnegative(),
  learning: z.number().int().nonnegative(),
  mastered: z.number().int().nonnegative(),
  struggling: z.number().int().nonnegative(),
});

const languageContextSchema = z.object({
  masteryBreakdown: statusCountsSchema,
  dueCount: z.object({
    dueWithinOneDay: z.number().int().nonnegative(),
    dueWithinWeek: z.number().int().nonnegative(),
  }),
  accuracy: z.object({
    accuracyPercent: z.number().int().min(0).max(100),
    sampleSize: z.number().int().nonnegative(),
  }),
  hintRate: z.object({
    hintRatePercent: z.number().int().min(0).max(100),
    sampleSize: z.number().int().nonnegative(),
  }),
  byAbility: z.object({
    recall: statusCountsSchema,
    reading: statusCountsSchema,
  }),
  wrongAnswerCount: z.number().int().nonnegative(),
  studyVolume: z.number().int().nonnegative(),
});

export const outputSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  ja: languageContextSchema,
  en: languageContextSchema,
});

export type GetLearningContextInput = z.infer<typeof inputSchema>;
export type GetLearningContextOutput = z.infer<typeof outputSchema>;

const LANGUAGES: Language[] = ["ja", "en"];

/**
 * @param now 計算時間視窗的基準時間；由呼叫端傳入以利測試（避免內部偷用 `new Date()`），
 *   跟 `src/domain/srs.ts`／`src/domain/stats.ts` 既有函式的慣例一致。正式路由不傳，
 *   用預設值即可。
 */
export async function handler(
  supabase: SupabaseClient,
  input: GetLearningContextInput,
  now: Date = new Date()
): Promise<GetLearningContextOutput> {
  const windowStartIso = new Date(now.getTime() - input.days * 24 * 60 * 60 * 1000).toISOString();

  let itemRows: LearningItemRow[];
  let scheduleRows: ScheduleStateRow[];
  let attemptRows: ReviewAttemptRow[];
  try {
    const [itemsResult, scheduleResult, attemptsResult] = await Promise.all([
      supabase.from("learning_items").select("*"),
      supabase.from("schedule_states").select("*"),
      supabase.from("review_attempts").select("*").gte("reviewed_at", windowStartIso),
    ]);

    if (itemsResult.error) throw itemsResult.error;
    if (scheduleResult.error) throw scheduleResult.error;
    if (attemptsResult.error) throw attemptsResult.error;

    itemRows = (itemsResult.data ?? []) as LearningItemRow[];
    scheduleRows = (scheduleResult.data ?? []) as ScheduleStateRow[];
    attemptRows = (attemptsResult.data ?? []) as ReviewAttemptRow[];
  } catch (error) {
    console.error("【get_learning_context】查詢資料失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`【get_learning_context】查詢資料失敗: ${error instanceof Error ? error.message : String(error)}`);
  }

  const items = itemRows.map(mapLearningItemRow);
  const scheduleStates = scheduleRows.map(mapScheduleStateRow);
  const attempts = attemptRows.map(mapReviewAttemptRow);

  const itemsById = new Map(items.map((item) => [item.id, item]));
  const wrongUnits = buildWrongAnswerUnits(items, attempts);

  const perLanguage: Record<Language, z.infer<typeof languageContextSchema>> = {} as Record<
    Language,
    z.infer<typeof languageContextSchema>
  >;

  for (const language of LANGUAGES) {
    const accuracy = computeAccuracyOverWindow(attempts, language, now, input.days);
    const hintRate = computeHintRateOverWindow(attempts, language, now, input.days);
    const wrongAnswerCount = wrongUnits.filter((unit) => itemsById.get(unit.learningItemId)?.language === language).length;

    perLanguage[language] = {
      masteryBreakdown: computeStatusCounts(items, language),
      dueCount: computeUpcomingReviewOverview(scheduleStates, language, now),
      accuracy,
      hintRate,
      byAbility: computeAbilityStatusCounts(items, scheduleStates, language),
      wrongAnswerCount,
      // studyVolume 跟 accuracy/hintRate 的 sampleSize 是同一組「這個語言、這個時間窗內的
      // review_attempts 筆數」（三者共用同一個 filter），不需要重複計算一次。
      studyVolume: accuracy.sampleSize,
    };
  }

  return { days: input.days, ja: perLanguage.ja, en: perLanguage.en };
}
