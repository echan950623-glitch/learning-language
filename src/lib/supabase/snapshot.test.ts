import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "./pagination";
import { fetchStableSnapshot } from "./snapshot";

it("discards a torn 1201-row download and retries every page under a stable revision", async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: "1" }).mockResolvedValueOnce({ data: "2" }).mockResolvedValue({ data: "2" });
  let round = 0;
  const rows = await fetchStableSnapshot({ rpc } as unknown as SupabaseClient, () => {
    round += 1;
    return fetchAllRows((from, to) => Promise.resolve({ data: Array.from({ length: 1201 }, (_, i) => ({ id: i, round })).slice(from, to + 1), error: null }));
  });
  expect(rows).toHaveLength(1201);
  expect(rows.every(row => (row as { round: number }).round === 2)).toBe(true);
});
it("refuses incomplete snapshots when revisions keep changing or the revision RPC fails", async () => {
  let version = 0;
  const rpc = vi.fn(async () => ({ data: String(version++) }));
  const load = vi.fn(async () => ["partial"]);
  await expect(fetchStableSnapshot({ rpc } as unknown as SupabaseClient, load)).rejects.toThrow("持續更新");
  expect(load).toHaveBeenCalledTimes(3);
  await expect(fetchStableSnapshot({ rpc: async () => ({ error: new Error("unavailable") }) } as unknown as SupabaseClient, load)).rejects.toThrow("unavailable");
});
