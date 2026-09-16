import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { handler, inputSchema } from "./previewVocabularyBatch";

/**
 * 故意不實作 `upsert`：如果 handler 呼叫了 upsert，測試會直接因為
 * "supabase.from(...).upsert is not a function" 一類的錯誤失敗，藉此證明
 * preview_vocabulary_batch 絕對不會寫入任何資料。
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

describe("preview_vocabulary_batch handler", () => {
  it("回傳 validItems／duplicates／errors，且不含內部用的 contentKey 欄位", async () => {
    const result = await handler(fakeSupabase([]), {
      items: [
        { promptZh: "貓", answer: "猫", reading: "ねこ" },
        { promptZh: "", answer: "狗" },
      ],
    });

    expect(result.validItems).toHaveLength(1);
    expect(result.validItems[0]).not.toHaveProperty("contentKey");
    expect(result.validItems[0]).toMatchObject({ promptZh: "貓", answer: "猫", romaji: "neko", language: "ja", type: "vocabulary" });
    expect(result.errors).toEqual([{ index: 1, message: expect.stringContaining("promptZh") }]);
    expect(result.duplicates).toHaveLength(0);
  });

  it("找出跟現有詞彙重複的項目", async () => {
    const contentKey = "ja|vocabulary|貓|猫|ねこ";
    const result = await handler(fakeSupabase([{ id: "item_existing", content_key: contentKey }]), {
      items: [{ promptZh: "貓", answer: "猫", reading: "ねこ" }],
    });

    expect(result.validItems).toHaveLength(0);
    expect(result.duplicates).toEqual([
      { index: 0, contentKey, reason: "existing_in_database", existingItemId: "item_existing" },
    ]);
  });
});

describe("preview_vocabulary_batch inputSchema", () => {
  it("items 至少要有 1 筆，最多 100 筆", () => {
    expect(inputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(inputSchema.safeParse({ items: Array.from({ length: 101 }, () => ({ promptZh: "a", answer: "b" })) }).success).toBe(
      false
    );
    expect(inputSchema.safeParse({ items: [{ promptZh: "a", answer: "b" }] }).success).toBe(true);
  });

  it("每個 item 欄位在 zod 層級是寬鬆的（必填驗證留給 handler 逐筆做）", () => {
    // 刻意連 promptZh／answer 都不給，zod 仍然要能 parse 成功——「必填」由
    // validateVocabularyBatch 逐筆檢查、寫進 errors，不是靠 zod 整批拒絕。
    expect(inputSchema.safeParse({ items: [{}] }).success).toBe(true);
  });
});
