import { fetchAllRows } from "@/lib/supabase/pagination";
import { fetchStableSnapshot } from "@/lib/supabase/snapshot";
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
  computeUpcomingReviewOverview,
  computeLearningEvidenceStats,
  computeEvidenceStatusCounts,
} from "@/domain/stats";
import type { Language, DailyPlan } from "@/domain/types";
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
  "詞彙回想／讀音的穩定程度、到期量、每日計畫、首答、提示、补考及模式來源。主要正確率請使用 evidence.dueFirstAccuracy：到期首次無提示作答。" +
  "accuracy 保留舊版全部作答統計以相容既有客戶端，不能當成獨立回想成功率；舊紀錄無法分類的部分另列 legacyUnclassified。" +
  "只提供建議，不修改排程或自行發放新字額度。英文為四選一意思理解，不能當成拼寫或口說證據。";

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
  learningRulesVersion: z.literal(2),
  evidence: z.object({
    dueFirstAccuracy: z.object({ accuracyPercent: z.number(), sampleSize: z.number() }),
    firstAttempts: z.number(), retries: z.number(), hinted: z.number(), legacyUnclassified: z.number(), studyDays: z.number(), effectiveTimeMs: z.number(), byMode: z.record(z.string(), z.number()),
  }),
  dailyPlans: z.array(z.object({ date: z.string(), timeZone: z.string(), newItemCap: z.number(), reservedNewWords: z.number(), plannedUnits: z.number(), completedUnits: z.number(), reason: z.string(), busy: z.boolean() })),
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
    meaning: statusCountsSchema,
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
  let planRows: { plan: DailyPlan }[];
  try {
    [itemRows, scheduleRows, attemptRows, planRows] = await fetchStableSnapshot(supabase, () => Promise.all([
      fetchAllRows<LearningItemRow>((from, to) => supabase.from("learning_items").select("*").order("id").range(from, to)),
      fetchAllRows<ScheduleStateRow>((from, to) => supabase.from("schedule_states").select("*").order("learning_item_id").order("ability").range(from, to)),
      fetchAllRows<ReviewAttemptRow>((from, to) => supabase.from("review_attempts").select("*").gte("reviewed_at", windowStartIso).order("id").range(from, to)),
      fetchAllRows<{ plan: DailyPlan }>((from, to) => supabase.from("daily_learning_plans").select("plan").order("id").range(from, to)),
    ]));
  } catch (error) {
    console.error("【get_learning_context】查詢資料失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`【get_learning_context】查詢資料失敗: ${error instanceof Error ? error.message : String(error)}`);
  }

  const items = itemRows.filter(row => !row.archived_at && !row.learning_metadata?.coachReport).map(mapLearningItemRow);
  const activeIds = new Set(items.map(item => item.id));
  const scheduleStates = scheduleRows.filter(row => activeIds.has(row.learning_item_id)).map(mapScheduleStateRow);
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
      learningRulesVersion: 2,
      evidence: computeLearningEvidenceStats(attempts, language, now, input.days),
      dailyPlans: planRows.filter(row => row.plan.language === language && row.plan.date >= windowStartIso.slice(0,10)).map(({plan}) => ({ date: plan.date, timeZone: plan.timeZone, newItemCap: plan.newItemCap,
        reservedNewWords: plan.newItemIds.length, plannedUnits: plan.units.length, completedUnits: plan.completedUnitKeys.length, reason: plan.reason, busy: plan.busy })),
      masteryBreakdown: computeEvidenceStatusCounts(items, scheduleStates, language, attempts),
      dueCount: computeUpcomingReviewOverview(scheduleStates, language, now),
      accuracy,
      hintRate,
      byAbility: computeAbilityStatusCounts(items, scheduleStates, language, true, attempts),
      wrongAnswerCount,
      // studyVolume 跟 accuracy/hintRate 的 sampleSize 是同一組「這個語言、這個時間窗內的
      // review_attempts 筆數」（三者共用同一個 filter），不需要重複計算一次。
      studyVolume: accuracy.sampleSize,
    };
  }

  return { days: input.days, ja: perLanguage.ja, en: perLanguage.en };
}
