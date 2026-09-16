import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { handler } from "./getVocabularyInventory";
import type { LearningItemRow } from "@/lib/mcp/supabaseRows";

interface RowWithContentKey extends LearningItemRow {
  content_key: string;
}

function fakeSupabase(rows: RowWithContentKey[], totalCountOverride?: number): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "learning_items") throw new Error(`未預期的 table: ${table}`);
      return {
        select(_columns: string, opts?: { count?: string; head?: boolean }) {
          if (opts?.head) {
            return Promise.resolve({ data: null, error: null, count: totalCountOverride ?? rows.length });
          }
          const builder = {
            order() {
              return builder;
            },
            limit(n: number) {
              return Promise.resolve({ data: rows.slice(0, n), error: null });
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
}

function makeRow(overrides: Partial<RowWithContentKey>): RowWithContentKey {
  return {
    id: "item_1",
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
    tags: ["動物"],
    status: "learning",
    created_at: "2026-09-01T00:00:00.000Z",
    is_seed: false,
    content_key: "ja|vocabulary|貓|猫|ねこ",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("get_vocabulary_inventory handler", () => {
  it("回傳 items 並依 content_key／tags／language／type 統計分布", async () => {
    const rows: RowWithContentKey[] = [
      makeRow({ id: "item_1", tags: ["動物"] }),
      makeRow({ id: "item_2", tags: ["動物", "N5"] }), // 跟 item_1 同一組 content_key，是重複
      makeRow({
        id: "item_3",
        content_key: "en|vocabulary|狗|dog|",
        language: "en",
        prompt_zh: "狗",
        answer: "dog",
        reading: null,
        tags: ["N5"],
      }),
    ];

    const result = await handler(fakeSupabase(rows), { limit: 500 });

    expect(result.totalCount).toBe(3);
    expect(result.returnedCount).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(3);

    expect(result.duplicateContentKeys).toEqual([
      { contentKey: "ja|vocabulary|貓|猫|ねこ", itemIds: ["item_1", "item_2"] },
    ]);

    const tagCounts = Object.fromEntries(result.tagDistribution.map((t) => [t.tag, t.count]));
    expect(tagCounts).toEqual({ 動物: 2, N5: 2 });

    const languageCounts = Object.fromEntries(result.languageDistribution.map((l) => [l.language, l.count]));
    expect(languageCounts).toEqual({ ja: 2, en: 1 });

    const typeCounts = Object.fromEntries(result.typeDistribution.map((t) => [t.type, t.count]));
    expect(typeCounts).toEqual({ vocabulary: 3 });
  });

  it("totalCount 大於實際回傳筆數時 truncated 為 true", async () => {
    const rows: RowWithContentKey[] = [makeRow({ id: "item_1" })];
    const result = await handler(fakeSupabase(rows, 999), { limit: 1 });

    expect(result.totalCount).toBe(999);
    expect(result.returnedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("沒有任何單字時回傳全空的安全預設值", async () => {
    const result = await handler(fakeSupabase([], 0), { limit: 500 });

    expect(result).toMatchObject({
      totalCount: 0,
      returnedCount: 0,
      truncated: false,
      items: [],
      duplicateContentKeys: [],
      tagDistribution: [],
      languageDistribution: [],
      typeDistribution: [],
    });
  });
});
