import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { validateVocabularyBatch, type VocabularyBatchItemInput } from "./vocabularyBatchShared";

/**
 * 最小可用的假 Supabase client：只實作 `validateVocabularyBatch` 實際會呼叫的
 * `.from("learning_items").select("id, content_key").in("content_key", keys)` 這條鏈，
 * 不需要網路、也不需要真的資料庫。
 */
function fakeSupabase(existingRows: { id: string; content_key: string }[]): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "learning_items") throw new Error(`未預期的 table: ${table}`);
      return {
        select() {
          return {
            in() {
              return Promise.resolve({ data: existingRows, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("validateVocabularyBatch", () => {
  it("promptZh／answer 缺少或空字串時列入 errors，不會出現在 validItems", async () => {
    const items: VocabularyBatchItemInput[] = [
      { promptZh: "", answer: "猫" },
      { promptZh: "狗", answer: "" },
      { answer: "本" },
    ];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toMatchObject({ index: 0, message: expect.stringContaining("promptZh") });
    expect(result.errors[1]).toMatchObject({ index: 1, message: expect.stringContaining("answer") });
    expect(result.errors[2]).toMatchObject({ index: 2, message: expect.stringContaining("promptZh") });
  });

  it("reading 提供空字串時視為錯誤（可選但若提供必須非空）", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", reading: "" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.errors).toEqual([{ index: 0, message: expect.stringContaining("reading") }]);
    expect(result.validItems).toHaveLength(0);
  });

  it("tags 含空字串元素時視為錯誤", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", tags: ["動物", ""] }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.errors).toEqual([{ index: 0, message: expect.stringContaining("tags") }]);
  });

  it("沒有提供 romaji 時，用 toRomaji(reading) 自動補上，不算 warning", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", reading: "ねこ" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems).toHaveLength(1);
    expect(result.validItems[0].romaji).toBe("neko");
    expect(result.validItems[0].warnings).toHaveLength(0);
  });

  it("提供的 romaji 與 reading 不一致時不擋下（仍是 validItems），但回報 warning 並改用系統推導值", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", reading: "ねこ", romaji: "nego" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems).toHaveLength(1);
    expect(result.validItems[0].romaji).toBe("neko");
    expect(result.validItems[0].warnings).toHaveLength(1);
    expect(result.validItems[0].warnings[0]).toContain("nego");
    expect(result.validItems[0].warnings[0]).toContain("neko");
  });

  it("提供的 romaji 與 reading 一致時不產生 warning", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", reading: "ねこ", romaji: "neko" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems[0].warnings).toHaveLength(0);
  });

  it("沒有 reading 時原樣保留呼叫端提供的 romaji，不產生 warning", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "cat", romaji: "cat" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems[0].romaji).toBe("cat");
    expect(result.validItems[0].warnings).toHaveLength(0);
  });

  it("批次內部重複（相同 language/type/promptZh/answer/reading）只有第一筆進 validItems，其餘標記 duplicate_within_batch", async () => {
    const items: VocabularyBatchItemInput[] = [
      { promptZh: "貓", answer: "猫", reading: "ねこ" },
      { promptZh: "貓", answer: "猫", reading: "ねこ" },
    ];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems).toHaveLength(1);
    expect(result.validItems[0].index).toBe(0);
    expect(result.duplicates).toEqual([
      { index: 1, contentKey: "ja|vocabulary|貓|猫|ねこ", reason: "duplicate_within_batch" },
    ]);
  });

  it("跟資料庫既有 content_key 重複時標記 existing_in_database，並附上 existingItemId", async () => {
    const contentKey = "ja|vocabulary|貓|猫|ねこ";
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫", reading: "ねこ" }];
    const result = await validateVocabularyBatch(
      fakeSupabase([{ id: "item_existing", content_key: contentKey }]),
      items
    );

    expect(result.validItems).toHaveLength(0);
    expect(result.duplicates).toEqual([
      { index: 0, contentKey, reason: "existing_in_database", existingItemId: "item_existing" },
    ]);
  });

  it("language／type 省略時預設 ja／vocabulary", async () => {
    const items: VocabularyBatchItemInput[] = [{ promptZh: "貓", answer: "猫" }];
    const result = await validateVocabularyBatch(fakeSupabase([]), items);

    expect(result.validItems[0].language).toBe("ja");
    expect(result.validItems[0].type).toBe("vocabulary");
  });

  it("全部項目都驗證失敗時，完全不查詢資料庫（afterBatchDedup 為空就提早回傳）", async () => {
    let queried = false;
    const supabase = {
      from() {
        queried = true;
        throw new Error("不應該被呼叫");
      },
    } as unknown as SupabaseClient;

    const result = await validateVocabularyBatch(supabase, [{ promptZh: "" }]);

    expect(queried).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.validItems).toHaveLength(0);
  });
});
