import { beforeEach, expect, it } from "vitest";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { questionConflictFixture } from "../../test/questionConflictFixture";
import { buildLearningQuestionRecovery } from "./learningQuestionRecovery";
import { canonicalJson } from "../../domain/learningPractice";
beforeEach(() => { installMockLocalStorage(); });

it("retains both real answers, every unsent event ID and frozen question when splitting the completed branch", () => {
  const f = questionConflictFixture(), original = canonicalJson(f);
  const recovery = buildLearningQuestionRecovery(f.store, f.entries, f.owner, f.remote, f.remoteAnswers);
  expect(canonicalJson(f)).toBe(original);
  expect(recovery.store.reviewAttempts).toHaveLength(f.store.reviewAttempts.length);
  expect(recovery.store.studySessions).toHaveLength(2);
  expect(recovery.store.studySessions[0]).toMatchObject({ status: "abandoned", exerciseResults: expect.any(Array) });
  expect(recovery.store.studySessions[0].exerciseResults).toHaveLength(2);
  expect(recovery.store.studySessions[1].exerciseResults.length).toBe(f.entries.length);
  expect(recovery.entries.slice(1, -1).map(e => e.id)).toEqual(f.entries.map(e => e.id));
  for (let i = 0; i < f.entries.length; i++) {
    const old = f.entries[i], shifted = recovery.entries[i + 1];
    if (old.type !== "learning_event" || shifted.type !== "learning_event") throw new Error("fixture");
    expect(shifted.payload.id).toBe(old.payload.id);
    expect(shifted.payload.attempt).toEqual({ ...old.payload.attempt, session_id: recovery.store.studySessions[1].id, sequence_in_session: i });
  }
});

it("refuses missing cloud evidence, a different frozen question, or a partial/edited pending chain", () => {
  const f = questionConflictFixture();
  expect(() => buildLearningQuestionRecovery(f.store, f.entries, f.owner, f.remote, f.remoteAnswers.slice(0, 1))).toThrow("無法安全恢復");
  const changed = structuredClone(f.remoteAnswers);
  changed[1].learning_metadata!.question.answer = "different";
  expect(() => buildLearningQuestionRecovery(f.store, f.entries, f.owner, f.remote, changed)).toThrow("無法安全恢復");
  expect(() => buildLearningQuestionRecovery(f.store, f.entries.slice(1), f.owner, f.remote, f.remoteAnswers)).toThrow("無法安全恢復");
});
