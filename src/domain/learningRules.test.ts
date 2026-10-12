import { expect, it } from "vitest";
import { createDailyPlan, enqueueRetry, evidenceStatus, learningDay, scheduleEvidence } from "./learningRules";
import type { LearningItem, ScheduleState } from "./types";
const NOW = new Date("2026-10-03T00:00:00Z");
const items: LearningItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `i${i}`, language: "ja", type: "vocabulary", promptZh: `詞義${i}`, answer: `漢字${i}`, reading: "かな", source: "manual", tags: [], status: "new", createdAt: NOW.toISOString(), isSeed: false }));
const context = { result: "correct", usedHint: false, attemptNumber: 0, introduced: true, sessionId: "s1", timeZone: "Asia/Taipei", now: NOW } as const;
it("reserves only five distinct words across rounds and gives no new words in busy/zero/backlog modes", () => {
  const first = createDailyPlan(items, [], NOW, 5);
  expect(first.newItemIds).toHaveLength(5);
  const second = createDailyPlan(items, [], NOW, 5, false, first);
  expect(second.newItemIds).toEqual(first.newItemIds);
  expect(createDailyPlan(items, [], NOW, 0).newItemIds).toHaveLength(0);
  expect(createDailyPlan(items, [], NOW, 0).units).toHaveLength(0);
  expect(first.units.every(u => first.newItemIds.includes(u.learningItemId))).toBe(true);
  expect(createDailyPlan(items, [], NOW, 5, true).newItemIds).toHaveLength(0);
  const schedules: ScheduleState[] = items.slice(0, 10).flatMap(i => ["recall", "reading"].map(ability => ({ learningItemId: i.id, language: "ja", ability: ability as "recall" | "reading", dueAt: NOW.toISOString(), intervalDays: 1, streak: 1, lapseCount: 0 })));
  expect(createDailyPlan(items, schedules, NOW, 5).newItemIds).toHaveLength(0);
  expect(createDailyPlan(items, schedules.filter(s => s.ability === "recall"), NOW, 0).units.some(u => u.ability === "reading")).toBe(true);
});
it("only cross-day due successes build stability; hinted/retest/non-due practice does not extend SRS", () => {
  let state = scheduleEvidence(undefined, context)!;
  expect(state.intervalDays).toBe(1);
  expect(state.evidenceStreak).toBe(0);
  expect(scheduleEvidence(state, context)?.streak).toBe(state.streak);
  expect(scheduleEvidence(state, { ...context, usedHint: true })).toEqual(state);
  expect(scheduleEvidence(state, { ...context, usedHint: true, now: new Date(state.dueAt) })?.evidenceStreak).toBe(0);
  expect(scheduleEvidence(state, { ...context, attemptNumber: 1, result: "incorrect" })).toEqual(state);
  for (let i = 0; i < 5; i++) state = scheduleEvidence(state, { ...context, sessionId: `s${i+2}`, now: new Date(state.dueAt) })!;
  expect(evidenceStatus(state)).toBe("mastered");
  expect(scheduleEvidence(undefined, { ...context, introduced: false })).toBeUndefined();
});
it("reinforcement is spaced, bounded and can end after another failure", () => {
  let units = items.slice(0, 5).map(item => ({ learningItemId: item.id, ability: "recall" as const, kind: "review" as const, attemptNumber: 0 }));
  units = enqueueRetry(units, 0, "incorrect", false) as typeof units;
  expect(units[4].learningItemId).toBe("i0");
  expect(units[4].attemptNumber).toBe(1);
  expect(enqueueRetry(units, 4, "incorrect", false)).toEqual(units);
  expect(enqueueRetry([{ ...units[0], attemptNumber: 2 }, ...units], 0, "incorrect", false)).toHaveLength(units.length+1);
});
it("uses the account time zone at midnight and refuses yesterday's reservation", () => {
  expect(learningDay(new Date("2026-10-02T15:59:59Z"))).toBe("2026-10-02");
  expect(learningDay(new Date("2026-10-02T16:00:00Z"))).toBe("2026-10-03");
  const plan = createDailyPlan(items, [], new Date("2026-10-02T15:59:59Z"), 5);
  expect(() => createDailyPlan(items, [], NOW, 5, false, plan)).toThrow();
});
