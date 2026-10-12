import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isLearningPractice } from "@/domain/learningPractice";
import type { LearningItemRow } from "@/repository/sync/outbox";
const schema = z
  .object({
    itemId: z.string().min(1).max(160),
    learned: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
type Input = z.infer<typeof schema>;
async function read(client: SupabaseClient, input: Input) {
  schema.parse(input);
  if (input.enabled && !input.learned)
    throw new Error("未確認學過的內容不能啟用。");
  const result = await client
    .from("learning_items")
    .select("*")
    .eq("id", input.itemId)
    .maybeSingle();
  if (result.error) throw new Error("讀取練習失敗，請重試。");
  const row = result.data as LearningItemRow | null;
  if (
    !row ||
    row.archived_at ||
    row.language !== "ja" ||
    !isLearningPractice(row.learning_metadata?.practice)
  )
    throw new Error("找不到可調整的日文練習內容。");
  return row;
}
export const previewPracticeStatus = {
  name: "preview_practice_status",
  title: "預覽練習啟用狀態",
  description:
    "預覽已存練習的已學／啟用／暫停變更。learned=true 必須依使用者明確告知已學；不改題目、歷史、排程，先取得確認。",
  inputSchema: schema,
  outputSchema: z.object({}).catchall(z.unknown()),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
  async handler(client: SupabaseClient, input: Input) {
    const row = await read(client, input);
    return {
      itemId: row.id,
      title: row.learning_metadata!.practice!.title,
      before: {
        learned: row.learning_metadata!.practice!.learned,
        enabled: row.learning_metadata!.practice!.enabled,
      },
      after: { learned: input.learned, enabled: input.enabled },
      changesScheduling: false,
      expectedContentVersion: row.learning_metadata!.contentVersion ?? 1,
    };
  },
};
export const setPracticeStatus = {
  name: "set_practice_status",
  title: "確認啟用或暫停練習",
  description:
    "必須先 preview_practice_status 並取得使用者確認，confirm=true 才更新已學／啟用狀態。保留題目、作答與到期日；只更新本帳戶，並行內容變更會拒絕覆寫。",
  inputSchema: schema.extend({
    confirm: z.literal(true),
    expectedContentVersion: z.number().int().min(1),
  }),
  outputSchema: z.object({}).catchall(z.unknown()),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
  async handler(
    client: SupabaseClient,
    userId: string,
    input: Input & { confirm: true; expectedContentVersion: number },
  ) {
    if (input.confirm !== true) throw new Error("尚未確認變更。");
    const { confirm: _, expectedContentVersion, ...request } = input;
    void _;
    const row = await read(client, request);
    if ((row.learning_metadata!.contentVersion ?? 1) !== expectedContentVersion)
      throw new Error("題目版本已變更，請重新預覽確認。");
    if (row.user_id !== userId) throw new Error("帳戶不符，未寫入。");
    const metadata = row.learning_metadata!;
    const practice = metadata.practice!;
    if (
      practice.learned === input.learned &&
      practice.enabled === input.enabled
    )
      return { id: row.id, duplicate: true, changesScheduling: false };
    const result = await client
      .from("learning_items")
      .update({
        learning_metadata: {
          ...metadata,
          practice: {
            ...practice,
            learned: input.learned,
            enabled: input.enabled,
          },
        },
      })
      .eq("id", row.id)
      .eq("user_id", userId)
      .eq("learning_metadata", JSON.stringify(metadata))
      .select("id");
    if (result.error)
      throw new Error("更新失敗，原內容已保留。" + result.error.message);
    if (!result.data?.length)
      throw new Error("內容在預覽後有其他變更，未覆寫；請重新讀取並確認。");
    return { id: row.id, duplicate: false, changesScheduling: false };
  },
};
