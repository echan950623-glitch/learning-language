import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { handler } from "./getLearningContext";
import type { LearningItemRow, ReviewAttemptRow, ScheduleStateRow } from "@/lib/mcp/supabaseRows";

interface Tables {
  learning_items: LearningItemRow[];
  schedule_states: ScheduleStateRow[];
  review_attempts: ReviewAttemptRow[];
}

/**
 * 假的 Supabase client：`.select("*")` 本身可以直接 await（回傳全部 rows），
 * 也可以再串一個 `.gte(col, min)`（review_attempts 查詢用），兩種呼叫方式
 * `getLearningContext.handler` 都會用到。
 */
function fakeSupabase(tables: Tables): SupabaseClient {
  return {
    from(table: keyof Tables) {
      const rows = tables[table] ?? [];
      return {
        select() {
          return {
            gte(column: string, min: string) {
              return Promise.resolve({
                data: rows.filter((row) => String((row as unknown as Record<string, unknown>)[column]) >= min),
                error: null,
              });
            },
            then(resolve: (value: { data: unknown; error: null }) => void, reject: (reason: unknown) => void) {
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

const NOW = new Date("2026-09-16T00:00:00.000Z");

const itemNeko: LearningItemRow = {
  id: "item_neko",
  user_id: "u1",
  language: "ja",
  type: "vocabulary",
  prompt_zh: "貓",
  answer: "猫",
  reading: "ねこ",
  explanation: null,
  romaji: "neko",
  part_of_speech: null,
  example_sentence: null,
  source: "manual",
  tags: [],
  status: "learning",
  created_at: "2026-09-01T00:00:00.000Z",
  is_seed: false,
  content_key: "ja|vocabulary|貓|猫|ねこ",
  updated_at: "2026-09-01T00:00:00.000Z",
};

const itemInu: LearningItemRow = {
  ...itemNeko,
  id: "item_inu",
  prompt_zh: "狗",
  answer: "いぬ",
  reading: null,
  romaji: null,
  status: "new",
  content_key: "ja|vocabulary|狗|いぬ|",
};

const scheduleNekoRecall: ScheduleStateRow = {
  user_id: "u1",
  learning_item_id: "item_neko",
  ability: "recall",
  language: "ja",
  due_at: "2026-09-17T00:00:00.000Z",
  interval_days: 1,
  streak: 1,
  lapse_count: 0,
  last_reviewed_at: "2026-09-15T00:00:00.000Z",
  updated_at: "2026-09-15T00:00:00.000Z",
};

const scheduleNekoReading: ScheduleStateRow = {
  user_id: "u1",
  learning_item_id: "item_neko",
  ability: "reading",
  language: "ja",
  due_at: "2026-09-20T00:00:00.000Z",
  interval_days: 3,
  streak: 0,
  lapse_count: 1,
  last_reviewed_at: "2026-09-14T00:00:00.000Z",
  updated_at: "2026-09-14T00:00:00.000Z",
};

const attemptRecallCorrect: ReviewAttemptRow = {
  id: "att1",
  user_id: "u1",
  session_id: "s1",
  sequence_in_session: 0,
  seq: 1,
  exercise_id: "ex1",
  learning_item_id: "item_neko",
  language: "ja",
  exercise_type: "recall",
  result: "correct",
  used_hint: false,
  response_time_ms: 1000,
  reviewed_at: "2026-09-15T00:00:00.000Z",
};

const attemptReadingIncorrect: ReviewAttemptRow = {
  id: "att2",
  user_id: "u1",
  session_id: "s1",
  sequence_in_session: 1,
  seq: 2,
  exercise_id: "ex2",
  learning_item_id: "item_neko",
  language: "ja",
  exercise_type: "reading",
  result: "incorrect",
  used_hint: false,
  response_time_ms: 2000,
  reviewed_at: "2026-09-14T00:00:00.000Z",
};

describe("get_learning_context handler", () => {
  it("完全沒有資料時，兩個語言都回傳全零的安全預設值", async () => {
    const supabase = fakeSupabase({ learning_items: [], schedule_states: [], review_attempts: [] });
    const result = await handler(supabase, { days: 7 }, NOW);

    expect(result.days).toBe(7);
    for (const language of ["ja", "en"] as const) {
      expect(result[language]).toMatchObject({
        masteryBreakdown: { total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 },
        dueCount: { dueWithinOneDay: 0, dueWithinWeek: 0 },
        accuracy: { accuracyPercent: 0, sampleSize: 0 },
        hintRate: { hintRatePercent: 0, sampleSize: 0 },
        wrongAnswerCount: 0,
        studyVolume: 0,
      });
    }
  });

  it("重用 domain 函式算出正確的每語言統計（ja 有資料，en 沒有）", async () => {
    const supabase = fakeSupabase({
      learning_items: [itemNeko, itemInu],
      schedule_states: [scheduleNekoRecall, scheduleNekoReading],
      review_attempts: [attemptRecallCorrect, attemptReadingIncorrect],
    });

    const result = await handler(supabase, { days: 7 }, NOW);

    expect(result.ja.masteryBreakdown).toEqual({ total: 2, new: 1, learning: 1, mastered: 0, struggling: 0 });
    expect(result.ja.dueCount).toEqual({ dueWithinOneDay: 1, dueWithinWeek: 2 });
    expect(result.ja.accuracy).toEqual({ accuracyPercent: 50, sampleSize: 2 });
    expect(result.ja.hintRate).toEqual({ hintRatePercent: 0, sampleSize: 2 });
    expect(result.ja.byAbility.recall).toEqual({ total: 2, new: 1, learning: 1, mastered: 0, struggling: 0 });
    expect(result.ja.byAbility.reading).toEqual({ total: 1, new: 0, learning: 1, mastered: 0, struggling: 0 });
    // 最新一次 reading 作答是 incorrect，recall 最新是 correct → 只有 reading 算錯題。
    expect(result.ja.wrongAnswerCount).toBe(1);
    // studyVolume 跟 accuracy.sampleSize 是同一組 filter，必須相等。
    expect(result.ja.studyVolume).toBe(result.ja.accuracy.sampleSize);

    expect(result.en.masteryBreakdown).toEqual({ total: 0, new: 0, learning: 0, mastered: 0, struggling: 0 });
  });

  it("review_attempts 的查詢有帶時間窗（days=7 排除窗外的作答）", async () => {
    const oldAttempt: ReviewAttemptRow = {
      ...attemptRecallCorrect,
      id: "att_old",
      exercise_id: "ex_old",
      reviewed_at: "2026-08-01T00:00:00.000Z", // 遠早於 7 天窗口
    };
    const supabase = fakeSupabase({
      learning_items: [itemNeko],
      schedule_states: [],
      review_attempts: [oldAttempt, attemptRecallCorrect],
    });

    const result = await handler(supabase, { days: 7 }, NOW);

    // 只有窗內的 attemptRecallCorrect 應該被算進去。
    expect(result.ja.accuracy.sampleSize).toBe(1);
  });
});
