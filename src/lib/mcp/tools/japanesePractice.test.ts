import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { getStudyProfile, previewPracticeBatch, addPracticeBatch, previewCoachReport, saveCoachReport } from "./japanesePractice";
import { getJapanesePracticeCatalog } from "@/domain/japanesePracticeCatalog";
import { practiceInput } from "@/domain/learningPractice";
import { learningItemToRow, reviewAttemptToRow } from "@/repository/sync/outbox";
import type { LearningItem, ReviewAttempt } from "@/domain/types";

const now = "2026-10-07T04:00:00.000Z";
const item: LearningItem = { ...practiceInput({ ...getJapanesePracticeCatalog()[0].practice, learned: true, enabled: true }), id: "practice-1", status: "new", contentVersion: 1, createdAt: now, isSeed: false };
function fakeClient(initial: Record<string, Record<string, unknown>[]>) {
  const tables = structuredClone(initial); const pages: string[] = []; let writes = 0;
  const client = { rpc: async () => ({ data: "0", error: null }), from(table: string) {
    let inserted: Record<string, unknown>[] | undefined;
    const query = {
      select() { return query; }, order() { return query; },
      range(from: number, to: number) { pages.push(`${table}:${from}`); return Promise.resolve({ data: (tables[table] ?? []).slice(from, to + 1), error: null }); },
      upsert(rows: Record<string, unknown> | Record<string, unknown>[]) {
        writes++; tables[table] ??= [];
        inserted = (Array.isArray(rows) ? rows : [rows]).filter(row => !tables[table].some(old => old.content_key === row.content_key));
        tables[table].push(...structuredClone(inserted)); return query;
      },
      then(resolve: (value: unknown) => void) { resolve({ data: inserted ?? tables[table] ?? [], error: null }); },
    }; return query;
  } } as unknown as SupabaseClient;
  return { client, tables, pages, writes: () => writes };
}
describe("Japanese MCP handoff stays separate from formal evidence", () => {
  it("reads all pages of >1000 attempts and preserves a cross-page session's raw answers", async () => {
    const attempts: ReviewAttempt[] = Array.from({ length: 1007 }, (_, i) => ({ id: `a${String(i).padStart(4, "0")}`, sessionId: "shared-session", exerciseId: `e${i}`, learningItemId: item.id, language: "ja", exerciseType: "recall", result: "incorrect", usedHint: i % 2 === 0, responseTimeMs: 1000, reviewedAt: new Date(Date.parse(now) + i * 1000).toISOString(),
      abilityEvidence: { ruleVersion: 2, mode: "random", attemptNumber: 0, wasDue: false, introduced: true, day: "2026-10-07", timeZone: "Asia/Taipei", rawAnswer: `raw${i}`, normalizedAnswer: `raw${i}`, originalResult: "incorrect", question: item, beforeSchedule: null, corrections: [] } }));
    const fake = fakeClient({ learning_items: [learningItemToRow(item, "owner") as unknown as Record<string, unknown>], review_attempts: attempts.map((a, i) => reviewAttemptToRow(a, i, "owner") as unknown as Record<string, unknown>) });
    const profile = await getStudyProfile.handler(fake.client, { offset: 0, limit: 50 });
    expect(fake.pages).toContain("review_attempts:1000");
    expect(profile.items[0].recentAnswers[0]).toMatchObject({ rawAnswer: "raw1006", mode: "random", usedHint: true });
    expect(profile.availableForms.some(f => f.id === "causative_passive")).toBe(true);
  });
  it("requires explicit confirmation and deduplicates repeated adds without marking unknown forms learned", async () => {
    const fake = fakeClient({ learning_items: [] });
    const input = { items: [{ catalogId: "form:te:production", learnedConfirmed: false }] };
    const preview = await previewPracticeBatch.handler(fake.client, input);
    expect(preview.ready[0].input.practice).toMatchObject({ learned: false, enabled: false });
    expect(fake.writes()).toBe(0);
    await expect(addPracticeBatch.handler(fake.client, "owner", { ...input, confirm: false as unknown as true })).rejects.toThrow("確認");
    expect((await addPracticeBatch.handler(fake.client, "owner", { ...input, confirm: true })).inserted).toHaveLength(1);
    expect((await addPracticeBatch.handler(fake.client, "owner", { ...input, confirm: true })).duplicates).toEqual([0]);
    expect(fake.writes()).toBe(1);
  });
  it("previews and saves assisted observations, retries reordered JSONB safely, and rejects changed reports or secrets", async () => {
    const fake = fakeClient({ learning_items: [] });
    const report = { externalId: "web-1", practicedAt: now, summary: "提示後完成て形", observations: [{ conceptKey: "form:te", capability: "production" as const, observation: "需要隔天無提示確認", assisted: true }] };
    expect((await previewCoachReport.handler(fake.client, report)).changesScheduling).toBe(false);
    await saveCoachReport.handler(fake.client, "owner", { ...report, confirm: true });
    const metadata = fake.tables.learning_items[0].learning_metadata as Record<string, unknown>;
    const original = metadata.coachReport as Record<string, unknown>;
    metadata.coachReport = Object.fromEntries(Object.entries(original).reverse());
    expect((await saveCoachReport.handler(fake.client, "owner", { ...report, confirm: true })).duplicate).toBe(true);
    await expect(saveCoachReport.handler(fake.client, "owner", { ...report, summary: "不同", confirm: true })).rejects.toThrow("內容不同");
    await expect(previewCoachReport.handler(fake.client, { ...report, summary: "access_token=not-a-real-token" })).rejects.toThrow("憑證");
    const profile = await getStudyProfile.handler(fake.client, { offset: 0, limit: 50 });
    expect(profile.totalCount).toBe(0); expect(profile.coachReports).toHaveLength(1); expect(fake.tables.review_attempts).toBeUndefined();
  });
});
