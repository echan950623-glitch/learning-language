import type { SupabaseClient } from "@supabase/supabase-js";

/** A transactionally maintained owner revision fences every page and every table. */
export async function fetchStableSnapshot<T>(client: SupabaseClient, load: () => Promise<T>): Promise<T> {
  const revision = async () => {
    const result = await client.rpc("get_learning_revision");
    if (result.error) throw result.error;
    if (typeof result.data !== "string" || !/^\d+$/.test(result.data)) throw new Error("雲端資料版本無法確認；已停止下載，不會覆蓋本機資料。");
    return result.data;
  };
  for (let retry = 0; retry < 3; retry += 1) {
    const before = await revision();
    const snapshot = await load();
    if (before === await revision()) return snapshot;
  }
  throw new Error("下載期間雲端資料持續更新，請稍後重試。原本的本機資料已保留。");
}
