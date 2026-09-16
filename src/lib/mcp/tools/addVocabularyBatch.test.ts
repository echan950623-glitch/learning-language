import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { handler, inputSchema } from "./addVocabularyBatch";

interface ExistingRow {
  id: string;
  content_key: string;
}

interface InsertRow {
  id: string;
  user_id: string;
  language: string;
  type: string;
  prompt_zh: string;
  answer: string;
  reading: string | null;
}

function computeContentKey(row: InsertRow): string {
  return [row.language, row.type, row.prompt_zh, row.answer, row.reading ?? ""].join("|");
}

interface FakeSupabaseOptions {
  /** 驗證階段（查既有 content_key）要回報「已存在」的 rows。 */
  existingRows?: ExistingRow[];
  /** upsert().select() 要回傳的 rows；省略時預設「全部都成功寫入」。 */
  upsertReturns?: (rows: InsertRow[]) => ExistingRow[];
}

function fakeSupabase(options: FakeSupabaseOptions = {}): { client: SupabaseClient; upsertCalls: { rows: InsertRow[]; opts: unknown }[] } {
  const existingRows = options.existingRows ?? [];
  const upsertCalls: { rows: InsertRow[]; opts: unknown }[] = [];

  const client = {
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
        upsert(rows: InsertRow[], opts: unknown) {
          upsertCalls.push({ rows, opts });
          return {
            select() {
              const data = options.upsertReturns
                ? options.upsertReturns(rows)
                : rows.map((row) => ({ id: row.id, content_key: computeContentKey(row) }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, upsertCalls };
}

const USER_ID = "user_1";

describe("add_vocabulary_batch handler", () => {
  it("驗證通過的新項目會被寫入，回傳 status=new／source=ai，且帶有實際 id", async () => {
    const { client, upsertCalls } = fakeSupabase();
    const result = await handler(client, USER_ID, {
      items: [{ promptZh: "貓", answer: "猫", reading: "ねこ" }],
      confirm: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skippedDuplicates).toHaveLength(0);
    expect(result.inserted).toHaveLength(1);
    expect(result.inserted[0]).toMatchObject({
      promptZh: "貓",
      answer: "猫",
      romaji: "neko",
      status: "new",
      source: "ai",
      language: "ja",
      type: "vocabulary",
    });
    expect(typeof result.inserted[0].id).toBe("string");

    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0].opts).toEqual({ onConflict: "user_id,content_key", ignoreDuplicates: true });
    expect(upsertCalls[0].rows[0]).toMatchObject({ user_id: USER_ID, status: "new", source: "ai", is_seed: false });
  });

  it("欄位驗證失敗的項目進 errors，不會被送去 upsert", async () => {
    const { client, upsertCalls } = fakeSupabase();
    const result = await handler(client, USER_ID, {
      items: [{ promptZh: "", answer: "猫" }],
      confirm: true,
    });

    expect(result.errors).toEqual([{ index: 0, message: expect.stringContaining("promptZh") }]);
    expect(result.inserted).toHaveLength(0);
    expect(upsertCalls).toHaveLength(0);
  });

  it("跟資料庫既有重複的項目進 skippedDuplicates，不會被送去 upsert", async () => {
    const contentKey = "ja|vocabulary|貓|猫|ねこ";
    const { client, upsertCalls } = fakeSupabase({ existingRows: [{ id: "item_existing", content_key: contentKey }] });

    const result = await handler(client, USER_ID, {
      items: [{ promptZh: "貓", answer: "猫", reading: "ねこ" }],
      confirm: true,
    });

    expect(result.inserted).toHaveLength(0);
    expect(result.skippedDuplicates).toEqual([
      { index: 0, contentKey, reason: "existing_in_database", existingItemId: "item_existing" },
    ]);
    expect(upsertCalls).toHaveLength(0);
  });

  it("驗證通過但 upsert 沒有回傳（寫入當下的競態衝突）時標記 conflict_on_insert", async () => {
    const { client } = fakeSupabase({ upsertReturns: () => [] });

    const result = await handler(client, USER_ID, {
      items: [{ promptZh: "貓", answer: "猫", reading: "ねこ" }],
      confirm: true,
    });

    expect(result.inserted).toHaveLength(0);
    expect(result.skippedDuplicates).toEqual([
      { index: 0, contentKey: "ja|vocabulary|貓|猫|ねこ", reason: "conflict_on_insert" },
    ]);
  });

  it("全部項目都不合法時，完全不呼叫 upsert", async () => {
    const { client, upsertCalls } = fakeSupabase();
    const result = await handler(client, USER_ID, { items: [{ answer: "猫" }], confirm: true });

    expect(result.inserted).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("add_vocabulary_batch inputSchema", () => {
  it("confirm 必須明確是 true，false／省略都不合法", () => {
    const items = [{ promptZh: "貓", answer: "猫" }];
    expect(inputSchema.safeParse({ items, confirm: true }).success).toBe(true);
    expect(inputSchema.safeParse({ items, confirm: false }).success).toBe(false);
    expect(inputSchema.safeParse({ items }).success).toBe(false);
  });
});
