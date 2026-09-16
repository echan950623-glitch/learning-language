/**
 * Supabase 資料表的 row 形狀（snake_case）與對應 domain 型別（camelCase）之間的轉換。
 *
 * 這裡的欄位對照 ARCHITECTURE.md「雲端化架構」章節的資料表定義。`src/lib/supabase/**`
 * 尚未提供產生好的 Database 型別（DB／安全 agent 尚未完成該檔案），所以先用手寫的 row
 * 介面搭配執行期窄轉型；等對方的產生型別就緒後可以直接替換，呼叫端（各 MCP 工具）不用改。
 */

import type {
  AbilityKind,
  ExerciseType,
  AttemptResult,
  ItemSource,
  ItemStatus,
  ItemType,
  Language,
  LearningItem,
  ReviewAttempt,
  ScheduleState,
} from "@/domain/types";

export interface LearningItemRow {
  id: string;
  user_id: string;
  language: string;
  type: string;
  prompt_zh: string;
  answer: string;
  reading: string | null;
  explanation: string | null;
  romaji: string | null;
  part_of_speech: string | null;
  example_sentence: string | null;
  source: string;
  tags: string[] | null;
  status: string;
  created_at: string;
  is_seed: boolean;
  content_key: string;
  updated_at: string;
}

export interface ScheduleStateRow {
  user_id: string;
  learning_item_id: string;
  ability: string;
  language: string;
  due_at: string;
  interval_days: number;
  streak: number;
  lapse_count: number;
  last_reviewed_at: string | null;
  updated_at: string;
}

export interface ReviewAttemptRow {
  id: string;
  user_id: string;
  session_id: string;
  sequence_in_session: number;
  seq: number;
  exercise_id: string;
  learning_item_id: string;
  language: string;
  exercise_type: string;
  result: string;
  used_hint: boolean;
  response_time_ms: number;
  reviewed_at: string;
}

export function mapLearningItemRow(row: LearningItemRow): LearningItem {
  return {
    id: row.id,
    language: row.language as Language,
    type: row.type as ItemType,
    promptZh: row.prompt_zh,
    answer: row.answer,
    reading: row.reading ?? undefined,
    explanation: row.explanation ?? undefined,
    romaji: row.romaji ?? undefined,
    partOfSpeech: row.part_of_speech ?? undefined,
    exampleSentence: row.example_sentence ?? undefined,
    source: row.source as ItemSource,
    tags: row.tags ?? [],
    status: row.status as ItemStatus,
    createdAt: row.created_at,
    isSeed: row.is_seed,
  };
}

export function mapScheduleStateRow(row: ScheduleStateRow): ScheduleState {
  return {
    learningItemId: row.learning_item_id,
    ability: row.ability as AbilityKind,
    language: row.language as Language,
    dueAt: row.due_at,
    intervalDays: row.interval_days,
    streak: row.streak,
    lapseCount: row.lapse_count,
    lastReviewedAt: row.last_reviewed_at ?? undefined,
  };
}

export function mapReviewAttemptRow(row: ReviewAttemptRow): ReviewAttempt {
  return {
    id: row.id,
    exerciseId: row.exercise_id,
    learningItemId: row.learning_item_id,
    language: row.language as Language,
    exerciseType: row.exercise_type as ExerciseType,
    sessionId: row.session_id,
    result: row.result as AttemptResult,
    usedHint: row.used_hint,
    responseTimeMs: row.response_time_ms,
    reviewedAt: row.reviewed_at,
  };
}
