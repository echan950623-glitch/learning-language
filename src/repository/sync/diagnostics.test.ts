import { describe, expect, it } from "vitest";

import { createEmptyStore } from "../schema";
import { buildSyncDiagnostics } from "./diagnostics";
import type { AliasStoreSnapshot } from "./alias";
import type { OutboxEntry, RecordGradedAttemptRpcInput } from "./outbox";

function gradedPayload(overrides: Partial<RecordGradedAttemptRpcInput> = {}): RecordGradedAttemptRpcInput {
  return {
    attempt_id: "attempt_1", session_id: "session_1", learning_item_id: "item_local", ability: "recall",
    exercise_id: "ex_1", exercise_type: "recall", result: "correct", used_hint: false, response_time_ms: 500,
    reviewed_at: "2026-01-06T00:05:00.000Z", expected_schedule: null,
    schedule: { due_at: "2026-01-07T00:05:00.000Z", interval_days: 1, streak: 1, lapse_count: 0 },
    item_status: "learning", session_completed: false, session_completed_at: null,
    ...overrides,
  };
}

function entry(operation: Omit<OutboxEntry, "id" | "createdAt" | "attempts">): OutboxEntry {
  return { ...operation, id: "outbox_1", createdAt: "2026-01-06T00:05:00.000Z", attempts: 3, lastError: "sync_conflict:schedule_changed" } as OutboxEntry;
}

describe("buildSyncDiagnostics", () => {
  it("空佇列沒有 head", () => {
    expect(buildSyncDiagnostics([], createEmptyStore(), null)).toEqual({ pendingCount: 0, pendingByType: {}, head: null });
  });

  it("首筆作答：顯示類型、expected=null、本機沒有排程，並統計各類型數量；不含單字內容", () => {
    const store = createEmptyStore();
    store.items.push({
      id: "item_local", language: "ja", type: "vocabulary", promptZh: "機密中文", answer: "機密答案", reading: "きみつ",
      source: "manual", tags: [], status: "new", createdAt: "2026-01-01T00:00:00.000Z", isSeed: false,
    });
    const aliases: AliasStoreSnapshot = { items: [{ localId: "item_local", canonicalId: "item_cloud", createdAt: "2026-01-05T00:00:00.000Z" }], attempts: [], conflicts: [] };
    const result = buildSyncDiagnostics(
      [entry({ type: "record_graded_attempt", payload: gradedPayload() }), entry({ type: "abandon_session", payload: { sessionId: "s" } })],
      store,
      aliases
    );
    expect(result.pendingCount).toBe(2);
    expect(result.pendingByType).toEqual({ record_graded_attempt: 1, abandon_session: 1 });
    expect(result.head).toMatchObject({
      type: "record_graded_attempt", attempts: 3, lastError: "sync_conflict:schedule_changed",
      localItemId: "item_local", canonicalItemId: "item_cloud", ability: "recall",
      expectedSchedule: null, localSchedule: null, localItemStatus: "new",
    });
    expect(JSON.stringify(result)).not.toContain("機密");
  });

  it("mark_attempt_correct 由本機 attempt 反查項目與能力", () => {
    const store = createEmptyStore();
    store.reviewAttempts.push({
      id: "attempt_1", exerciseId: "ex_1", learningItemId: "item_local", language: "ja", exerciseType: "reading",
      sessionId: "session_1", result: "incorrect", usedHint: false, responseTimeMs: 1, reviewedAt: "2026-01-06T00:05:00.000Z",
    });
    store.scheduleStates.push({
      learningItemId: "item_local", ability: "reading", language: "ja", dueAt: "2026-01-07T00:00:00.000Z",
      intervalDays: 1, streak: 0, lapseCount: 1, lastReviewedAt: "2026-01-06T00:05:00.000Z",
    });
    const expected = { due_at: "2026-01-07T00:00:00.000Z", interval_days: 1, streak: 0, lapse_count: 1, last_reviewed_at: "2026-01-06T00:05:00.000Z" };
    const result = buildSyncDiagnostics(
      [entry({ type: "mark_attempt_correct", payload: {
        session_id: "session_1", exercise_id: "ex_1", expected_schedule: expected,
        schedule: { due_at: "2026-01-09T00:00:00.000Z", interval_days: 3, streak: 1, lapse_count: 1 }, item_status: "learning",
      } })],
      store,
      null
    );
    expect(result.head).toMatchObject({
      type: "mark_attempt_correct", localItemId: "item_local", canonicalItemId: "item_local", ability: "reading",
      expectedSchedule: { streak: 0, lapseCount: 1 }, localSchedule: { streak: 0, lapseCount: 1 },
    });
  });
});
