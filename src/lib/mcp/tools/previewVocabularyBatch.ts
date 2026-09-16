/**
 * MCP 工具：`preview_vocabulary_batch`。不寫入任何資料，純粹驗證＋整形，讓 AI 助理／
 * 使用者在真正新增前看得到「哪些會被新增、哪些重複、哪些有錯」。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { validateVocabularyBatch, vocabularyBatchItemInputSchema } from "./vocabularyBatchShared";

export const name = "preview_vocabulary_batch";

export const title = "預覽新增單字批次";

export const description =
  "預覽一批要新增的單字：驗證必填欄位、核對／補上羅馬拼音、找出跟現有詞彙或批次內部重複的" +
  "項目。不會寫入任何資料。**新增單字前必須先呼叫這個工具，把結果呈現給使用者並取得明確" +
  "確認，才可以呼叫 add_vocabulary_batch**；不能略過這一步直接新增。";

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

export const inputSchema = z.object({
  items: z.array(vocabularyBatchItemInputSchema).min(1).max(100).describe("要預覽的單字清單，1～100 筆"),
});

const validItemOutputSchema = z.object({
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
  warnings: z.array(z.string()),
});

const duplicateOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  contentKey: z.string(),
  reason: z.enum(["existing_in_database", "duplicate_within_batch"]),
  existingItemId: z.string().optional(),
});

const errorOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  message: z.string(),
});

export const outputSchema = z.object({
  validItems: z.array(validItemOutputSchema),
  duplicates: z.array(duplicateOutputSchema),
  errors: z.array(errorOutputSchema),
});

export type PreviewVocabularyBatchInput = z.infer<typeof inputSchema>;
export type PreviewVocabularyBatchOutput = z.infer<typeof outputSchema>;

export async function handler(
  supabase: SupabaseClient,
  input: PreviewVocabularyBatchInput
): Promise<PreviewVocabularyBatchOutput> {
  const { validItems, duplicates, errors } = await validateVocabularyBatch(supabase, input.items);

  return {
    validItems: validItems.map((item) => ({
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
      warnings: item.warnings,
    })),
    duplicates,
    errors,
  };
}
