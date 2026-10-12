import { expect, it } from "vitest";
import { effectiveSchedules, limitVerificationUnits, verificationState } from "./automaticVerification";
import { freezeVocabularyVerification, vocabularyVerificationQuestions } from "./verificationContexts";
import { buildTodayQueue } from "./queue";
import { selectPracticeUnits } from "./practiceSelection";
import { freezePracticeQuestion, practiceInput } from "./learningPractice";
import { getJapanesePracticeCatalog } from "./japanesePracticeCatalog";
import { buildExerciseForUnit } from "./exercises";
import { createDailyPlan } from "./learningRules";
import type { LearningItem, ReviewAttempt, ScheduleState, StudySessionPlannedUnit } from "./types";

const word: LearningItem = { id: "word", language: "ja", type: "vocabulary", answer: "予約", reading: "よやく", promptZh: "預約", source: "manual", tags: [], status: "learning", createdAt: "2026-09-01T00:00:00.000Z", introducedAt: "2026-09-01T00:00:00.000Z", isSeed: false };
const iso = (day: string) => `${day}T00:00:00.000Z`;
const schedule: ScheduleState = { learningItemId: word.id, ability: "recall", language: "ja", dueAt: iso("2026-09-10"), intervalDays: 7, streak: 2, lapseCount: 0 };
function attempt(day: string, extra: Partial<ReviewAttempt> = {}, q = word): ReviewAttempt {
  return { id: day, learningItemId: word.id, language: "ja", exerciseId: day, exerciseType: "recall", sessionId: day, result: "correct", usedHint: false, responseTimeMs: 100,
    reviewedAt: iso(day), abilityEvidence: { ruleVersion: 2, mode: "today", attemptNumber: 0, wasDue: true, introduced: true, day, timeZone: "Asia/Taipei", rawAnswer: "予約", normalizedAnswer: "予約", originalResult: "correct", question: q, beforeSchedule: schedule, corrections: [] }, ...extra };
}
const successes = [attempt("2026-09-01"), attempt("2026-09-08")];
it("automatically reduces repeats only after two independent days separated by seven days, then checks at 30 and 60 days", () => {
  expect(verificationState(word, "recall", [schedule], successes)).toMatchObject({ stage: "verified", dueAt: iso("2026-10-08"), independentDays: 2 });
  expect(buildTodayQueue([word], [schedule], new Date(iso("2026-10-07")), 0, successes).reviewUnits).toEqual([]);
  expect(buildTodayQueue([word], [schedule], new Date(iso("2026-10-08")), 0, successes).reviewUnits).toHaveLength(1);
  const checked = [...successes, attempt("2026-10-08")];
  expect(verificationState(word, "recall", [schedule], checked).dueAt).toBe(iso("2026-12-07"));
  expect(effectiveSchedules([word], [schedule], successes)[0].dueAt).toBe(iso("2026-10-08"));
  expect(schedule.dueAt).toBe(iso("2026-09-10"));
});
it("does not promote same-day practice, hints, retries, non-due answers, legacy records or changed content", () => {
  const second = attempt("2026-09-08");
  for (const bad of [ { ...second, usedHint: true }, { ...second, abilityEvidence: { ...second.abilityEvidence!, attemptNumber: 1 } }, { ...second, abilityEvidence: { ...second.abilityEvidence!, wasDue: false } }, { ...second, abilityEvidence: undefined } ]) {
    expect(verificationState(word, "recall", [schedule], [successes[0], bad]).stage).toBe("learning");
  }
  expect(verificationState(word, "recall", [schedule], [successes[0], attempt("2026-09-03")]).stage).toBe("learning");
  expect(verificationState({ ...word, promptZh: "新的詞義" }, "recall", [schedule], successes).stage).toBe("learning");
  expect(verificationState({ ...word, acceptedAnswers: ["よやく"] }, "recall", [schedule], successes).stage).toBe("learning");
  expect(verificationState({ ...word, needsUnderstanding: true }, "recall", [schedule], successes).stage).toBe("learning");
});
it("a failed reading check changes only reading evidence; a failure returns that ability to ordinary scheduling", () => {
  const reading = successes.map(a => ({ ...a, exerciseType: "reading" as const }));
  const failed = attempt("2026-10-08", { exerciseType: "reading", result: "incorrect" });
  const history = [...successes, ...reading, failed];
  expect(verificationState(word, "recall", [schedule], history).stage).toBe("verified");
  expect(verificationState(word, "reading", [{ ...schedule, ability: "reading" }], history).stage).toBe("learning");
  expect(history).toHaveLength(5);
});
it("self-report grants no evidence, waits one day and old permanent pauses remain excluded", () => {
  const requested = { ...word, autoVerificationRequestedAt: iso("2026-09-08") };
  expect(verificationState(requested, "recall", [schedule], successes)).toMatchObject({ stage: "pending", dueAt: iso("2026-09-09") });
  expect(buildTodayQueue([requested], [schedule], new Date(iso("2026-09-08")), 0, successes).units).toEqual([]);
  expect(verificationState(requested, "recall", [schedule], [...successes, attempt("2026-09-09", { result: "incorrect" }, requested)]).stage).toBe("learning");
  expect(buildTodayQueue([{ ...requested, reviewPaused: true }], [schedule], new Date(iso("2027-01-01")), 0, successes).units).toEqual([]);
});
it("reserves at most two due checks without starving them behind a backlog", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ ...word, id: `w${i}` }));
  const attempts = items.slice(0, 3).flatMap(i => successes.map(a => ({ ...a, learningItemId: i.id, abilityEvidence: { ...a.abilityEvidence!, question: i } })));
  const schedules = items.map(i => ({ ...schedule, learningItemId: i.id }));
  const units: StudySessionPlannedUnit[] = items.slice().reverse().map(i => ({ learningItemId: i.id, ability: "recall", kind: "review" }));
  const result = limitVerificationUnits(units, items, schedules, attempts, 5);
  expect(result.map(u => u.learningItemId)).toEqual(["w2", "w1", "w4", "w3"]);
});
it("recommended practice never fills a short round with stable non-due content, while explicit all is available", () => {
  const selection = { category: "vocabulary" as const, source: "recommended" as const, skill: "recall" as const, concepts: [], questionCount: 10 };
  const now = new Date(iso("2026-09-11"));
  expect(selectPracticeUnits([word], successes, [schedule], selection, now).units).toEqual([]);
  expect(selectPracticeUnits([word], successes, [schedule], { ...selection, source: "all" }, now).units).toHaveLength(1);
  const stale = createDailyPlan([word], [schedule], now, 0);
  expect(createDailyPlan([word], [schedule], now, 0, false, stale, undefined, successes).units.some(u => u.ability === "recall")).toBe(false);
});
it("uses genuinely unused contexts and distinguishes repeated context from unsupported custom vocabulary", () => {
  const first = freezeVocabularyVerification(word, "recall", new Set());
  expect(first.verificationQuestion).toMatchObject({ kind: "context", novel: true });
  expect(first.promptZh).toContain("（　）");
  const second = freezeVocabularyVerification(word, "recall", new Set([first.verificationQuestion.key]));
  expect(second.verificationQuestion.key).not.toBe(first.verificationQuestion.key);
  const keys = new Set(vocabularyVerificationQuestions(word, "recall").map(q => q.key));
  expect(freezeVocabularyVerification(word, "recall", keys).verificationQuestion.novel).toBe(false);
  const custom = freezeVocabularyVerification({ ...word, answer: "固有名詞" }, "reading", new Set());
  expect(custom.verificationQuestion).toMatchObject({ kind: "retention", novel: false });
  expect(buildExerciseForUnit(custom, "reading").prompt).toBe("固有名詞");
  const check = attempt("2026-10-08", {}, first);
  expect(verificationState(word, "recall", [schedule], [...successes, check]).contextVerified).toBe(true);
  expect(verificationState(word, "recall", [schedule], [...successes, check, attempt("2026-10-09", { result: "incorrect" })]).contextVerified).toBe(false);
});
it("holds a parallel question out of ordinary practice and records novelty honestly", () => {
  const entry = getJapanesePracticeCatalog().find(e => e.practice.variants.length >= 3 && e.practice.kind === "grammar")!;
  const item: LearningItem = { ...word, ...practiceInput({ ...entry.practice, learned: true, enabled: true }) };
  const reserved = item.practice!.variants.at(-1)!;
  const prior = item.practice!.variants.slice(0, -1).map(v => ({ ...item, practice: { ...item.practice!, activeVariantId: v.id } }));
  const check = freezePracticeQuestion(item, [], new Set(), true, prior);
  expect(check.practice!.activeVariantId).toBe(reserved.id);
  expect(check.verificationQuestion?.novel).toBe(true);
  const repeat = freezePracticeQuestion(item, [], new Set(), true, [...prior, check]);
  expect(repeat.verificationQuestion?.novel).toBe(false);
  expect(freezePracticeQuestion(item, [], new Set(), false).practice!.activeVariantId).not.toBe(reserved.id);
});
it("does not mistake success on reading for verification of spelling and meaning in mixed vocabulary packs", () => {
  const entry = getJapanesePracticeCatalog().find(e => e.practice.variants.some(v => v.id === "orthography"))!;
  const item: LearningItem = { ...word, ...practiceInput({ ...entry.practice, learned: true, enabled: true }) };
  const history = item.practice!.variants.flatMap((v, index) => [0, 7].map(offset => {
    const day = new Date(Date.parse(iso("2026-09-01")) + (index * 14 + offset) * 86_400_000).toISOString().slice(0, 10);
    return attempt(day, {}, { ...item, answer: v.answer, promptZh: v.prompt, practice: { ...item.practice!, activeVariantId: v.id } });
  }));
  expect(verificationState(item, "recall", [schedule], history.slice(0, 2)).stage).toBe("learning");
  expect(verificationState(item, "recall", [schedule], history).stage).toBe("verified");
  const prior = history[3];
  expect(freezePracticeQuestion(item, [prior]).practice?.activeVariantId).toBe("meaning");
});
