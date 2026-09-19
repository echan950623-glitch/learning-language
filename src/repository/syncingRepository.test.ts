import { beforeEach, describe, expect, it } from "vitest";

import { installMockLocalStorage } from "../test/localStorageMock";
import { LocalStorageLearningRepository } from "./localStorageRepository";
import { writePersistedStore } from "./schema";
import { SyncingLearningRepository } from "./syncingRepository";
import { __clearOutboxForTests, listOutboxEntries } from "./sync/outbox";

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
});

describe("SyncingLearningRepository CAS payload", () => {
  it("作答與改判都帶上修改前排程，並使用本機 attempt ID", () => {
    writePersistedStore({
      schemaVersion: 2,
      items: [{
        id: "item_1", language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬",
        reading: "いぬ", source: "manual", tags: [], status: "learning",
        createdAt: "2026-01-01T00:00:00.000Z", isSeed: false,
      }],
      scheduleStates: [{
        learningItemId: "item_1", ability: "recall", language: "ja",
        dueAt: "2026-01-08T00:00:00.000Z", intervalDays: 3, streak: 2, lapseCount: 1,
        lastReviewedAt: "2026-01-05T00:00:00.000Z",
      }],
      reviewAttempts: [],
      studySessions: [{
        id: "session_1", language: "ja", status: "in_progress", startedAt: "2026-01-08T00:00:00.000Z",
        plannedUnits: [{ learningItemId: "item_1", ability: "recall", kind: "review" }],
        exerciseResults: [], newItemIds: [], reviewItemIds: ["item_1"],
      }],
    });
    const repository = new SyncingLearningRepository(new LocalStorageLearningRepository(), "user_1");

    const graded = repository.recordGradedAttempt({
      sessionId: "session_1", learningItemId: "item_1", ability: "recall", exerciseId: "ex_1",
      exerciseType: "recall", result: "incorrect", usedHint: false, responseTimeMs: 500,
      now: new Date("2026-01-08T00:05:00.000Z"),
    });
    const first = listOutboxEntries()[0];
    expect(first.type).toBe("record_graded_attempt");
    if (first.type !== "record_graded_attempt") throw new Error("unexpected outbox operation");
    expect(first.payload.attempt_id).toBe(graded.attempt.id);
    expect(first.payload.expected_schedule).toEqual({
      due_at: "2026-01-08T00:00:00.000Z", interval_days: 3, streak: 2, lapse_count: 1,
      last_reviewed_at: "2026-01-05T00:00:00.000Z",
    });

    const scheduleBeforeCorrection = graded.schedule;
    repository.markAttemptCorrect({ sessionId: "session_1", exerciseId: "ex_1" });
    const second = listOutboxEntries()[1];
    expect(second.type).toBe("mark_attempt_correct");
    if (second.type !== "mark_attempt_correct") throw new Error("unexpected outbox operation");
    expect(second.payload.expected_schedule).toEqual({
      due_at: scheduleBeforeCorrection.dueAt,
      interval_days: scheduleBeforeCorrection.intervalDays,
      streak: scheduleBeforeCorrection.streak,
      lapse_count: scheduleBeforeCorrection.lapseCount,
      last_reviewed_at: scheduleBeforeCorrection.lastReviewedAt ?? null,
    });
  });
});
