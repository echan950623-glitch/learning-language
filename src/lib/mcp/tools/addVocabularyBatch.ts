/**
 * MCP 工具：`add_vocabulary_batch`。這是四個工具裡唯一會寫入資料的一個。
 *
 * 安全設計（照 ARCHITECTURE.md 的理由，不要改成簽章 preview token）：MCP 呼叫是無狀態的
 * HTTP 請求，preview 與 add 之間可能相隔任意時間（使用者在確認前跟真人或模型討論），
 * 這段時間資料庫可能已經改變，所以這裡**重新完整跑一次**跟 preview 一樣的驗證
 * （`validateVocabularyBatch`），不信任呼叫端「已經 preview 過」的宣稱。重新驗證的成本
 * 就是同一組查詢，比維護簽章 token 或伺服器端 session 簡單也更正確。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { generateId } from "@/domain/id";

import { validateVocabularyBatch, vocabularyBatchItemInputSchema, type ValidCandidate } from "./vocabularyBatchShared";

export const name = "add_vocabulary_batch";

export const title = "新增單字批次";

export const description =
  "在使用者明確確認後，把一批新單字寫入資料庫。**執行前必須先呼叫 preview_vocabulary_batch " +
  "並讓使用者看過結果、給出明確確認**；這裡的 confirm 欄位必須明確傳 true（不能省略、不能是" +
  "false）。即使已經呼叫過 preview，這裡仍會重新完整驗證一次（必填欄位、羅馬拼音、重複偵測），" +
  "因為兩次呼叫之間資料庫可能已經改變。新項目一律標記 status=new、source=ai，這個工具永遠" +
  "不會覆蓋、修改或刪除任何既有單字。";

export const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

export const inputSchema = z.object({
  items: z.array(vocabularyBatchItemInputSchema).min(1).max(100).describe("要新增的單字清單，1～100 筆"),
  confirm: z.literal(true).describe("必須明確傳 true，代表使用者已經看過 preview_vocabulary_batch 的結果並確認新增"),
});

const insertedItemSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  promptZh: z.string(),
  answer: z.string(),
  reading: z.string().optional(),
  romaji: z.string().optional(),
  partOfSpeech: z.string().optional(),
  exampleSentence: z.string().optional(),
  tags: z.array(z.string()),
  language: z.enum(["ja", "en"]),
  type: z.enum(["vocabulary", "grammar", "phrase", "collocation"]),
  status: z.literal("new"),
  source: z.literal("ai"),
});

const skippedDuplicateSchema = z.object({
  index: z.number().int().nonnegative(),
  contentKey: z.string(),
  reason: z.enum(["existing_in_database", "duplicate_within_batch", "conflict_on_insert"]),
  existingItemId: z.string().optional(),
});

const errorOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  message: z.string(),
});

export const outputSchema = z.object({
  inserted: z.array(insertedItemSchema),
  skippedDuplicates: z.array(skippedDuplicateSchema),
  errors: z.array(errorOutputSchema),
});

export type AddVocabularyBatchInput = z.infer<typeof inputSchema>;
export type AddVocabularyBatchOutput = z.infer<typeof outputSchema>;

interface UpsertedRow {
  id: string;
  content_key: string;
}

function toInsertRow(item: ValidCandidate, userId: string, nowIso: string) {
  return {
    id: generateId("item"),
    user_id: userId,
    language: item.language,
    type: item.type,
    prompt_zh: item.promptZh,
    answer: item.answer,
    reading: item.reading ?? null,
    explanation: null,
    romaji: item.romaji ?? null,
    part_of_speech: item.partOfSpeech ?? null,
    example_sentence: item.exampleSentence ?? null,
    source: "ai",
    tags: item.tags,
    status: "new",
    created_at: nowIso,
    is_seed: false,
  };
}

export async function handler(
  supabase: SupabaseClient,
  userId: string,
  input: AddVocabularyBatchInput
): Promise<AddVocabularyBatchOutput> {
  const { validItems, duplicates, errors } = await validateVocabularyBatch(supabase, input.items);

  const skippedDuplicates: AddVocabularyBatchOutput["skippedDuplicates"] = duplicates.map((d) => ({
    index: d.index,
    contentKey: d.contentKey,
    reason: d.reason,
    existingItemId: d.existingItemId,
  }));

  if (validItems.length === 0) {
    return { inserted: [], skippedDuplicates, errors };
  }

  const nowIso = new Date().toISOString();
  const rows = validItems.map((item) => toInsertRow(item, userId, nowIso));

  let upsertedRows: UpsertedRow[];
  try {
    const { data, error } = await supabase
      .from("learning_items")
      .upsert(rows, { onConflict: "user_id,content_key", ignoreDuplicates: true })
      .select("id, content_key");
    if (error) throw error;
    upsertedRows = (data ?? []) as UpsertedRow[];
  } catch (error) {
    console.error("【add_vocabulary_batch】寫入 learning_items 失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`【add_vocabulary_batch】寫入失敗: ${error instanceof Error ? error.message : String(error)}`);
  }

  const insertedContentKeys = new Set(upsertedRows.map((row) => row.content_key));
  const idByContentKey = new Map(upsertedRows.map((row) => [row.content_key, row.id]));

  const inserted: AddVocabularyBatchOutput["inserted"] = [];
  for (const item of validItems) {
    const insertedId = idByContentKey.get(item.contentKey);
    if (!insertedContentKeys.has(item.contentKey) || !insertedId) {
      // 驗證通過但這次 upsert 沒有回傳＝寫入當下才發生的競態衝突
      // （例如另一個裝置在驗證之後、寫入之前，剛好新增了同樣內容的字）。
      skippedDuplicates.push({ index: item.index, contentKey: item.contentKey, reason: "conflict_on_insert" });
      continue;
    }
    inserted.push({
      id: insertedId,
      index: item.index,
      promptZh: item.promptZh,
      answer: item.answer,
      reading: item.reading,
      romaji: item.romaji,
      partOfSpeech: item.partOfSpeech,
      exampleSentence: item.exampleSentence,
      tags: item.tags,
      language: item.language,
      type: item.type,
      status: "new",
      source: "ai",
    });
  }

  return { inserted, skippedDuplicates, errors };
}
