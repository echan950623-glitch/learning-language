import { createClient } from "@supabase/supabase-js";
import { describe, it, expect, vi } from "vitest";
import { getJapanesePracticeCatalog } from "@/domain/japanesePracticeCatalog";
import { practiceInput } from "@/domain/learningPractice";
import { learningItemToRow } from "@/repository/sync/outbox";
import { previewPracticeStatus, setPracticeStatus } from "./practiceStatus";
function fixture(conflict = false) {
  const row = learningItemToRow(
    {
      ...practiceInput({
        ...getJapanesePracticeCatalog()[0].practice,
        learned: false,
        enabled: false,
      }),
      id: "p",
      createdAt: "2026-10-08T00:00:00Z",
      isSeed: false,
      status: "new",
      contentVersion: 3,
    },
    "owner",
  );
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(init.body as string);
      writes.push({ url: String(url), body });
      if (conflict) return new Response("[]");
      row.learning_metadata = body.learning_metadata;
      return new Response(JSON.stringify([{ id: row.id }]));
    }
    return new Response(JSON.stringify(row));
  });
  const client = createClient("https://example.test", "test-key", {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client, row, writes };
}
const input = { itemId: "p", learned: true, enabled: true };
describe("MCP practice status", () => {
  it("preview is read-only and rejects unknown enabled content", async () => {
    const f = fixture();
    expect(await previewPracticeStatus.handler(f.client, input)).toMatchObject({
      before: { learned: false, enabled: false },
      changesScheduling: false,
    });
    expect(f.writes).toHaveLength(0);
    await expect(
      previewPracticeStatus.handler(f.client, { ...input, learned: false }),
    ).rejects.toThrow("未確認");
  });
  it("requires confirmation and account ownership", async () => {
    const f = fixture();
    await expect(
      setPracticeStatus.handler(f.client, "owner", {
        ...input,
        confirm: false as unknown as true,
        expectedContentVersion: 3,
      }),
    ).rejects.toThrow("尚未確認");
    await expect(
      setPracticeStatus.handler(f.client, "other", {
        ...input,
        confirm: true,
        expectedContentVersion: 3,
      }),
    ).rejects.toThrow("帳戶不符");
    expect(f.writes).toHaveLength(0);
  });
  it("preserves question/version and checks owner plus exact old JSONB; retries are no-op", async () => {
    const f = fixture();
    const original = structuredClone(f.row.learning_metadata);
    await setPracticeStatus.handler(f.client, "owner", {
      ...input,
      confirm: true,
      expectedContentVersion: 3,
    });
    expect(f.row.learning_metadata).toEqual({
      ...original,
      practice: { ...original!.practice, learned: true, enabled: true },
    });
    const url = new URL(f.writes[0].url);
    expect(url.searchParams.get("user_id")).toBe("eq.owner");
    expect(url.searchParams.get("learning_metadata")).toBe(
      "eq." + JSON.stringify(original),
    );
    expect(Object.keys(f.writes[0].body)).toEqual(["learning_metadata"]);
    expect(
      await setPracticeStatus.handler(f.client, "owner", {
        ...input,
        confirm: true,
        expectedContentVersion: 3,
      }),
    ).toMatchObject({ duplicate: true });
    expect(f.writes).toHaveLength(1);
  });
  it("does not silently succeed when a concurrent change blocks update", async () => {
    const f = fixture(true);
    await expect(
      setPracticeStatus.handler(f.client, "owner", {
        ...input,
        confirm: true,
        expectedContentVersion: 3,
      }),
    ).rejects.toThrow("未覆寫");
    expect(f.row.learning_metadata!.practice!.enabled).toBe(false);
  });
  it("rejects approval for an older question version", async () => {
    const f = fixture();
    await expect(
      setPracticeStatus.handler(f.client, "owner", {
        ...input,
        confirm: true,
        expectedContentVersion: 2,
      }),
    ).rejects.toThrow("版本已變更");
    expect(f.writes).toHaveLength(0);
  });
});
