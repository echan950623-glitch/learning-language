/**
 * MCP 工具：`get_vocabulary_inventory`。只讀，列出使用者的單字庫存，讓 AI 助理在建議新
 * 單字前知道使用者已經有哪些字，避免建議重複內容。
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { mapLearningItemRow, type LearningItemRow } from "@/lib/mcp/supabaseRows";

export const name = "get_vocabulary_inventory";

export const title = "取得單字庫存清單";

export const description =
  "列出使用者目前的單字庫存（只讀，不會修改任何資料）：內容本身（依建立時間新到舊排序、" +
  "有 limit 上限避免無上限查詢）、依 content_key 找出的重複項、標籤分布、語言／類型分布。" +
  "用來讓 AI 助理知道使用者已經有哪些字，避免建議或新增重複的內容。";

export const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

export const inputSchema = z.object({
  limit: z.number().int().positive().max(2000).default(500).describe("最多回傳幾筆單字內容，預設 500，避免無上限查詢"),
});

const inventoryItemSchema = z.object({
  id: z.string(),
  language: z.enum(["ja", "en"]),
  type: z.enum(["vocabulary", "grammar", "phrase", "collocation"]),
  promptZh: z.string(),
  answer: z.string(),
  reading: z.string().optional(),
  romaji: z.string().optional(),
  partOfSpeech: z.string().optional(),
  tags: z.array(z.string()),
  status: z.enum(["new", "learning", "mastered", "struggling"]),
  source: z.enum(["ai", "textbook", "teacher", "song", "manual"]),
  createdAt: z.string(),
});

export const outputSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(),
  truncated: z.boolean().describe("totalCount 是否大於 returnedCount（受 limit 影響，重複偵測只涵蓋已回傳的這批）"),
  items: z.array(inventoryItemSchema),
  duplicateContentKeys: z.array(
    z.object({
      contentKey: z.string(),
      itemIds: z.array(z.string()),
    })
  ),
  tagDistribution: z.array(z.object({ tag: z.string(), count: z.number().int().nonnegative() })),
  languageDistribution: z.array(z.object({ language: z.enum(["ja", "en"]), count: z.number().int().nonnegative() })),
  typeDistribution: z.array(
    z.object({
      type: z.enum(["vocabulary", "grammar", "phrase", "collocation"]),
      count: z.number().int().nonnegative(),
    })
  ),
});

export type GetVocabularyInventoryInput = z.infer<typeof inputSchema>;
export type GetVocabularyInventoryOutput = z.infer<typeof outputSchema>;

interface RowWithContentKey extends LearningItemRow {
  content_key: string;
}

export async function handler(
  supabase: SupabaseClient,
  input: GetVocabularyInventoryInput
): Promise<GetVocabularyInventoryOutput> {
  let totalCount: number;
  let rows: RowWithContentKey[];
  try {
    const [countResult, rowsResult] = await Promise.all([
      supabase.from("learning_items").select("id", { count: "exact", head: true }),
      supabase.from("learning_items").select("*").order("created_at", { ascending: false }).limit(input.limit),
    ]);

    if (countResult.error) throw countResult.error;
    if (rowsResult.error) throw rowsResult.error;

    rows = (rowsResult.data ?? []) as RowWithContentKey[];
    totalCount = countResult.count ?? rows.length;
  } catch (error) {
    console.error("【get_vocabulary_inventory】查詢 learning_items 失敗:", {
      message: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string } | null)?.code,
      timestamp: new Date().toISOString(),
    });
    throw new Error(`【get_vocabulary_inventory】查詢 learning_items 失敗: ${error instanceof Error ? error.message : String(error)}`);
  }

  const contentKeyGroups = new Map<string, string[]>();
  const tagCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();

  for (const row of rows) {
    const ids = contentKeyGroups.get(row.content_key) ?? [];
    ids.push(row.id);
    contentKeyGroups.set(row.content_key, ids);

    for (const tag of row.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    languageCounts.set(row.language, (languageCounts.get(row.language) ?? 0) + 1);
    typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
  }

  const items = rows.map((row) => {
    const item = mapLearningItemRow(row);
    return {
      id: item.id,
      language: item.language,
      type: item.type,
      promptZh: item.promptZh,
      answer: item.answer,
      reading: item.reading,
      romaji: item.romaji,
      partOfSpeech: item.partOfSpeech,
      tags: item.tags,
      status: item.status,
      source: item.source,
      createdAt: item.createdAt,
    };
  });

  return {
    totalCount,
    returnedCount: rows.length,
    truncated: totalCount > rows.length,
    items,
    duplicateContentKeys: Array.from(contentKeyGroups.entries())
      .filter(([, ids]) => ids.length > 1)
      .map(([contentKey, itemIds]) => ({ contentKey, itemIds })),
    tagDistribution: Array.from(tagCounts.entries()).map(([tag, count]) => ({ tag, count })),
    languageDistribution: Array.from(languageCounts.entries()).map(([language, count]) => ({
      language: language as "ja" | "en",
      count,
    })),
    typeDistribution: Array.from(typeCounts.entries()).map(([type, count]) => ({
      type: type as "vocabulary" | "grammar" | "phrase" | "collocation",
      count,
    })),
  };
}
